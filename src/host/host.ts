import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { format } from 'node:util';
import type { Interface } from 'node:readline/promises';
import type { AttachedReplicatedState } from '@earendil-works/chord';
import { createModels } from '@earendil-works/pi-ai/models';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import type { Message, Models } from '@earendil-works/pi-ai';
import type { ConversationView } from '@earendil-works/pi-durable';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { protection, sandboxProblem, sshKeys } from '../runtime/guard.ts';
import { openInstance, transcript, answerText } from '../runtime/runtime.ts';
import type { Instance } from '../runtime/runtime.ts';
import { resumeInstance, settleAgents } from '../runtime/recovery.ts';
import { accessProblem, catalogProblem, checkAccess } from '../runtime/models.ts';
import { listAgents, REPORT_KIND } from '../agents/index.ts';
import { claudeCliProvider } from '../providers/claude-cli.ts';
import { backupOffline } from '../server/backup.ts';
import { formatBytes } from '../server/admin.ts';
import { serve } from '../server/serve.ts';
import { createUiSession } from '../ui/session.ts';
import { isCommand, runTui } from '../ui/tui/app.ts';
import { errorMessage, isRecord, parseConfig } from './config.ts';
import type { ModelSource } from './config.ts';

// Internal entry point: src/cli.ts owns the database flock for this process.
process.umask(0o077);
const config = parseConfig(process.argv[2]);
let instance: Instance | undefined;
let reader: Interface | undefined;
let watcher: AttachedReplicatedState<ConversationView> | undefined;
let stopping = false;
// A send in progress: its reply prints mid-wait, and the chat loop prompts once the send returns.
let sending = false;
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
    model: `${config.model.provider}/${config.model.modelId}`, modelSource: config.modelSource,
    memory: memory?.status() ?? config.memoryDir,
    scheduler: inspection.scheduling, pendingTasks: inspection.tasks.length,
    pendingSubmissions: inspection.submissions.length }, null, 2));
}

async function resumePending(): Promise<void> {
  const current = opened();
  const inspection = await current.harness.inspect(current.context);
  if (!inspection.tasks.length && !inspection.submissions.length) return;
  // An agent's anchor task is bookkeeping (a new chat's standing agents have one each), not work to report.
  const tasks = inspection.tasks.filter(task => task.record.kind !== 'agents.anchor').length;
  const queued = inspection.submissions.length;
  const work = [tasks && `${tasks} pending task(s)`, queued && `${queued} queued message(s)`].filter(Boolean);
  if (work.length) console.error(`Resuming ${work.join(' and ')}…`);
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
      if (!sending) reader?.prompt(true);
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

// The terminal UI owns the screen while it runs: stray console output (runtime reports, memory
// warnings) becomes host notices, which the session hands to every client as chat notices.
async function chatTui(): Promise<void> {
  const session = await createUiSession(opened(), config);
  const { error, warn } = console;
  try {
    await runTui(session, { cwd: config.cwd, signal: shutdown.signal, onStart: () => {
      console.error = console.warn = (...args: unknown[]) => session.notify(format(...args), 'warn');
    } });
  } finally {
    console.error = error;
    console.warn = warn;
    await session.close();
  }
}

/** The terminal UI's commands that line-by-line chat lacks, with what to do instead. */
const TUI_ONLY: Readonly<Record<string, string>> = { model: 'relaunch with --model PROVIDER/ID',
  effort: 'relaunch with --thinking LEVEL', thinking: 'relaunch with --thinking LEVEL', tools: 'relaunch with or without --no-tools',
  mem: 'run --status for the memory counters', stop: 'Ctrl+C closes the host; unfinished work resumes next launch' };

/** What line-by-line chat answers to a slash command it does not run. */
function unknownCommand(line: string): string {
  const word = line.split(/\s/, 1)[0] ?? line, instead = TUI_ONLY[word.slice(1)];
  return instead ? `${word} is in the terminal UI only; here, ${instead}.` : `Unknown command ${word}. Use /help.`;
}

const SOURCE: Readonly<Record<ModelSource, string>> = { flag: '--model', env: 'PI_DURABLE_MODEL',
  settings: 'saved by /model', default: 'default' };

/** The launch model must be in the catalog and have usable credentials; the same checks as /model. */
async function checkModel(models: Models): Promise<void> {
  const problem = catalogProblem(models, config.model) ?? accessProblem(config.model,
    await checkAccess(models, config.model.provider, { timeoutMs: 15_000, signal: shutdown.signal }), config.authFile);
  if (!problem) return;
  throw new Error(config.modelSource === 'settings'
    ? `${problem} (This model was saved by /model in ${config.settingsPath}; pass --model to launch with another.)` : problem);
}

async function main(): Promise<void> {
  if (config.command === 'backup') {
    // Under the flock with no server: this process is the only writer, and needs no models.
    const { path, bytes } = await backupOffline(config, config.out === undefined ? {} : { out: resolve(config.out) });
    console.log(`Backup written: ${path} (${formatBytes(bytes)})`);
    return;
  }
  if (config.command !== 'chat' && config.command !== 'serve') throw new Error(`${config.command} runs without the host`);
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
    await checkModel(models);
  }
  if (stopping) return;
  // The server owns its Instance, and closes it after its clients got `bye`.
  if (config.command === 'serve') return serve(config, { models, signal: shutdown.signal });
  if (config.allowTools && !config.inspectOnly) {
    const problem = await sandboxProblem(protection(config));
    if (problem) console.error(`Coding tools: bash is off. ${problem}`);
  }
  instance = await openInstance({ ...config, models, configureAgent: !config.inspectOnly, protection: protection(config), sshKeys: sshKeys(),
    onWarning: message => console.error(`Pi Durable: ${message}`),
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
  if (process.stdout.isTTY && !config.plain) return chatTui();
  console.log(`Pi · one chat that never ends · ${config.model.provider}/${config.model.modelId} (${SOURCE[config.modelSource]})\nDatabase: ${config.databasePath}\nMemory: ${config.memoryDir}`);
  console.log(`Tools: ${config.allowTools ? 'ENABLED — your user permissions, minus the protected folders (chat state, credentials hidden; system read-only)' : 'OFF (--no-tools was given; relaunch without it to enable)'}\n/help for commands. /exit or Ctrl+C closes; unfinished work remains resumable.\n`);
  await printHistory(6);
  watcher = await watchReplies();
  reader = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  // The iterator buffers lines typed or pasted while a command or a send runs; question() would drop them.
  const lines = reader[Symbol.asyncIterator]();
  reader.on('SIGINT', () => stop('SIGINT'));
  reader.once('close', () => {
    if (!stopping) {
      stopping = true;
      shutdown.abort(new Error('Terminal input closed'));
      void close()?.catch(() => {});
    }
  });
  while (!stopping) {
    reader.prompt();
    // Closing the reader (Ctrl+D, a signal, shutdown) ends the iterator.
    const next = await lines.next();
    if (next.done || stopping) break;
    const line = next.value.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') console.log('/history — saved messages\n/agents — spawned agents and whether they are busy\n/status — storage, memory and pending work\n/exit — close without discarding unfinished work\nAgents work in the background; their reports and Pi\'s replies print as they arrive.\nHere, tools and the model change only by relaunching (--no-tools, --model); the terminal UI has /tools and /model.');
    else if (line === '/history') await printHistory();
    else if (line === '/agents') await printAgents();
    else if (line === '/status') await printStatus();
    else if (isCommand(line)) console.error(unknownCommand(line));
    else {
      sending = true;
      try { await send(line, undefined, { print: false }); }
      catch (error) { if (!stopping) console.error(`pi-durable: ${errorMessage(error)}`); }
      finally { sending = false; }
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
