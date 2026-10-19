import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import type { AttachedReplicatedState } from '@earendil-works/chord';
import { createModels } from '@earendil-works/pi-ai/models';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import type { Message, Models } from '@earendil-works/pi-ai';
import type { ConversationView } from '@earendil-works/pi-durable';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openInstance, transcript, answerText } from '../runtime/runtime.ts';
import type { Instance } from '../runtime/runtime.ts';
import { resumeInstance, settleAgents } from '../runtime/recovery.ts';
import { listAgents, REPORT_KIND } from '../agents/index.ts';
import { anthropicSubscriptionSource } from '../providers/anthropic.ts';
import { CLAUDE_CLI, claudeCliProvider } from '../providers/claude-cli.ts';
import { errorMessage, isRecord, parseConfig } from './config.ts';

// Internal entry point: src/cli.ts owns the database flock for this process.
process.umask(0o077);
const config = parseConfig(process.argv[2]);
let instance: Instance | undefined;
let reader: Interface | undefined;
let watcher: AttachedReplicatedState<ConversationView> | undefined;
let stopping = false;
let closing: Promise<void> | undefined;
const shutdown = new AbortController();
const close = (): Promise<void> | undefined => closing ??= instance?.close();
const opened = (): Instance => {
  if (!instance) throw new Error('Instance is not open');
  return instance;
};
const stop = (signal: NodeJS.Signals): void => {
  stopping = true;
  shutdown.abort(new Error('Host is shutting down'));
  process.stdin.destroy();
  process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
  reader?.close();
  void close()?.catch(() => {});
};
const handlers = new Map((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, () => stop(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);

const textContent = (content: Message['content'] | undefined): string => typeof content === 'string' ? content
  : (content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('');
const field = (value: unknown, key: string): unknown => isRecord(value) ? value[key] : undefined;

async function printHistory(limit?: number): Promise<void> {
  const { root, context } = opened();
  const entries = await transcript(root, context);
  const messages = entries.flatMap(entry => (entry.model ?? []).map(message => ({ entry, message })))
    .filter(({ message }) => ['user', 'assistant'].includes(message.role) && textContent(message.content));
  for (const { entry, message } of limit ? messages.slice(-limit) : messages) {
    const who = entry.kind === REPORT_KIND ? 'Agent' : message.role === 'user' ? 'You' : 'Pi';
    console.log(`${who}: ${textContent(message.content)}\n`);
  }
  if (!messages.length) console.log('No messages saved yet.');
}

async function printStatus(): Promise<void> {
  const { harness, root, context, memory } = opened();
  const inspection = await harness.inspect(context);
  console.log(JSON.stringify({ database: config.databasePath, conversationId: root.id,
    memory: memory?.status() ?? config.memoryDir,
    scheduler: inspection.scheduling, pendingTasks: inspection.tasks.length,
    pendingSubmissions: inspection.submissions.length }, null, 2));
}

async function resumePending(): Promise<void> {
  const current = opened();
  const inspection = await current.harness.inspect(current.context);
  if (!inspection.tasks.length && !inspection.submissions.length) return;
  console.error(`Resuming ${inspection.tasks.length} pending task(s)…`);
  await resumeInstance(current);
}

async function printAgents(): Promise<void> {
  const { harness, context } = opened();
  const agents = await listAgents(harness, context);
  for (const agent of agents) console.log(`${agent.name} (${agent.role}, parent ${agent.parent}) ${agent.busy ? 'busy' : 'idle'}`);
  if (!agents.length) console.log('No agents yet. Ask Pi to spawn one.');
}

// In chat, every committed reply of Pi is printed as it lands, including runs
// started by agents' reports, which no submission here waits for.
async function watchReplies(): Promise<AttachedReplicatedState<ConversationView>> {
  const { root, context } = opened();
  const view = await root.viewState(context);
  const seen = new Set(view.value.entries.map(entry => entry.id));
  const show = (value: ConversationView): void => {
    for (const entry of value.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const text = (entry.model ?? []).map(message => textContent(message.content)).join('');
      if (!text || !['pi.assistant', REPORT_KIND].includes(entry.kind)) continue;
      process.stdout.write(`\r\x1b[K${entry.kind === REPORT_KIND ? text : `pi> ${text}`}\n\n`);
      reader?.prompt(true);
    }
  };
  view.subscribe(show);
  return view;
}

async function send(prompt: string, requestId?: string, { print = true } = {}): Promise<void> {
  const { root, context } = opened();
  if (process.stderr.isTTY && print) console.error('Working…');
  const submission = await root.submit({ type: 'input', content: prompt,
    ...(requestId ? { requestId } : {}) }, context);
  const answer = await answerText(root, await submission.wait(context), context);
  if (print) console.log(answer);
}

async function checkCredentials(models: Models): Promise<void> {
  const { provider, modelId } = config.model;
  const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]);
  if (!await models.checkAuth(provider, { signal })) {
    throw new Error(provider === CLAUDE_CLI
      ? 'No Claude Code login for claude-cli. Install Claude Code, run claude, then /login (or run claude auth login). PI_DURABLE_CLAUDE_BIN selects another claude binary.'
      : `No credentials for ${provider}. Run pi (or npm exec -- pi from the installation directory), then /login. API-key providers also accept their usual environment variable. Auth file: ${config.authFile}`);
  }
  const subscription = provider === 'anthropic' && await anthropicSubscriptionSource(models, { signal });
  if (subscription) {
    throw new Error(`Refusing anthropic/${modelId}: its credential is a Claude subscription (${subscription}), which Anthropic allows only in its own apps such as Claude Code. Use --model claude-cli/opus (or sonnet, haiku, fable), which runs the official claude CLI with your login, or an Anthropic Console API key in ANTHROPIC_API_KEY (remove a stored anthropic login first). See docs/models.md.`);
  }
}

async function main(): Promise<void> {
  let models: Models;
  // Registered on every launch, inspection included: persisted agents may name claude-cli models.
  const claude = claudeCliProvider();
  if (config.inspectOnly) {
    const catalog = createModels();
    catalog.setProvider(claude);
    models = catalog;
  } else {
    const runtime = await ModelRuntime.create({ authPath: config.authFile, modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false, signal: shutdown.signal });
    runtime.registerNativeProvider(claude);
    models = runtime;
    if (!models.getModel(config.model.provider, config.model.modelId)) {
      throw new Error(config.model.provider === CLAUDE_CLI
        ? `Unknown model claude-cli/${config.model.modelId}. Use opus, sonnet, haiku or fable.`
        : `Unknown model ${config.model.provider}/${config.model.modelId} in pinned Pi 1.3.0 catalog`);
    }
    await checkCredentials(models);
  }
  if (stopping) return;
  instance = await openInstance({ ...config, models, configureAgent: !config.inspectOnly,
    onReport: report => console.error(`Pi Durable: ${String(field(field(report, 'error'), 'message') ?? field(report, 'message') ?? field(report, 'kind') ?? 'runtime report')}`) });
  if (stopping) return;
  if (config.status) return printStatus();
  if (config.history) return printHistory();
  await resumePending();
  if (stopping) return;
  if (config.resume) {
    if (process.stderr.isTTY) console.error('Waiting for agents to finish…');
    await settleAgents(instance, { signal: shutdown.signal });
    return printHistory();
  }
  if (config.prompt !== undefined) return send(config.prompt, config.requestId);
  if (!process.stdin.isTTY) {
    let prompt = '';
    for await (const chunk of process.stdin) {
      prompt += String(chunk);
      if (prompt.length > 4 * 1024 * 1024) throw new Error('Piped prompt exceeds 4 MiB');
    }
    if (!prompt.trim()) throw new Error('Supply a prompt, pipe text, or run in a terminal for interactive chat');
    return send(prompt);
  }
  console.log(`Pi · one chat that never ends · ${config.model.provider}/${config.model.modelId}\nDatabase: ${config.databasePath}\nMemory: ${config.memoryDir}`);
  console.log(`Tools: ${config.allowTools ? 'ENABLED — full user permissions; no approval guards' : 'OFF (use --allow-tools to enable)'}\n/help for commands. /exit or Ctrl+C closes; unfinished work remains resumable.\n`);
  await printHistory(6);
  watcher = await watchReplies();
  reader = createInterface({ input: process.stdin, output: process.stdout });
  reader.on('SIGINT', () => stop('SIGINT'));
  reader.once('close', () => {
    if (!stopping) {
      stopping = true;
      shutdown.abort(new Error('Terminal input closed'));
      void close()?.catch(() => {});
    }
  });
  while (!stopping) {
    let line: string;
    // The reader's close listener sets `stopping`, so a question rejected by close ends the loop.
    try { line = (await reader.question('you> ', { signal: shutdown.signal })).trim(); }
    catch (error) { if (stopping) break; throw error; }
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') console.log('/history — saved messages\n/agents — spawned agents and whether they are busy\n/status — storage, memory and pending work\n/exit — close without discarding unfinished work\nAgents work in the background; their reports and Pi\'s replies print as they arrive.\nTools can only be changed by relaunching with or without --allow-tools.');
    else if (line === '/history') await printHistory();
    else if (line === '/agents') await printAgents();
    else if (line === '/status') await printStatus();
    else if (line.startsWith('/')) console.error('Unknown command. Use /help.');
    else {
      try { await send(line, undefined, { print: false }); }
      catch (error) { if (!stopping) console.error(`pi-durable: ${errorMessage(error)}`); }
    }
  }
}

try { await main(); }
catch (error) { if (!stopping) { console.error(`pi-durable: ${errorMessage(error)}`); process.exitCode = 1; } }
finally {
  watcher?.dispose();
  reader?.close();
  try { await close(); } catch (error) { console.error(`Closing failed: ${errorMessage(error)}`); process.exitCode = 1; }
  try { cleanupSessionResources(); }
  catch (error) { console.error(`Transport cleanup failed: ${errorMessage(error)}`); process.exitCode = 1; }
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
