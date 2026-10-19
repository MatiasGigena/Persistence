import { createInterface } from 'node:readline/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openInstance, transcript, answerText } from '../runtime/runtime.mjs';
import { resumeInstance, settleAgents } from '../runtime/recovery.mjs';
import { listAgents, REPORT_KIND } from '../agents/index.mjs';

// Internal entry point: src/cli.mjs owns the database flock for this process.
process.umask(0o077);
const config = JSON.parse(process.argv[2]);
let instance;
let reader;
let watcher;
let stopping = false;
let closing;
const shutdown = new AbortController();
const close = () => closing ??= instance?.close();
const stop = signal => {
  stopping = true;
  shutdown.abort(new Error('Host is shutting down'));
  process.stdin.destroy();
  process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
  reader?.close();
  void close()?.catch(() => {});
};
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => stop(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);

const textContent = content => typeof content === 'string' ? content
  : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');

async function printHistory(limit) {
  const entries = await transcript(instance.root, instance.context);
  const messages = entries.flatMap(entry => (entry.model ?? []).map(message => ({ entry, message })))
    .filter(({ message }) => ['user', 'assistant'].includes(message.role) && textContent(message.content));
  for (const { entry, message } of limit ? messages.slice(-limit) : messages) {
    const who = entry.kind === REPORT_KIND ? 'Agent' : message.role === 'user' ? 'You' : 'Pi';
    console.log(`${who}: ${textContent(message.content)}\n`);
  }
  if (!messages.length) console.log('No messages saved yet.');
}

async function printStatus() {
  const inspection = await instance.harness.inspect(instance.context);
  console.log(JSON.stringify({ database: config.databasePath, conversationId: instance.root.id,
    memory: instance.memory?.status() ?? config.memoryDir,
    scheduler: inspection.scheduling, pendingTasks: inspection.tasks.length,
    pendingSubmissions: inspection.submissions.length }, null, 2));
}

async function resumePending() {
  const { harness, root, context } = instance;
  const inspection = await harness.inspect(context);
  if (!inspection.tasks.length && !inspection.submissions.length) return;
  console.error(`Resuming ${inspection.tasks.length} pending task(s)…`);
  await resumeInstance(instance);
}

async function printAgents() {
  const agents = await listAgents(instance.harness, instance.context);
  for (const agent of agents) console.log(`${agent.name} (${agent.role}, parent ${agent.parent}) ${agent.busy ? 'busy' : 'idle'}`);
  if (!agents.length) console.log('No agents yet. Ask Pi to spawn one.');
}

// In chat, every committed reply of Pi is printed as it lands, including runs
// started by agents' reports, which no submission here waits for.
async function watchReplies() {
  const view = await instance.root.viewState(instance.context);
  const seen = new Set(view.value.entries.map(entry => entry.id));
  const show = value => {
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

async function send(prompt, requestId, { print = true } = {}) {
  const { root, context } = instance;
  if (process.stderr.isTTY && print) console.error('Working…');
  const submission = await root.submit({ type: 'input', content: prompt,
    ...(requestId ? { requestId } : {}) }, context);
  const answer = await answerText(root, await submission.wait(context), context);
  if (print) console.log(answer);
}

async function main() {
  let models;
  if (config.inspectOnly) models = createModels();
  else {
    models = await ModelRuntime.create({ authPath: config.authFile, modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false, signal: shutdown.signal });
    if (!models.getModel(config.model.provider, config.model.modelId)) {
      throw new Error(`Unknown model ${config.model.provider}/${config.model.modelId} in pinned Pi 1.3.0 catalog`);
    }
    if (!await models.checkAuth(config.model.provider, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15000)]) })) {
      throw new Error(`No credentials for ${config.model.provider}. Run pi (or npm exec -- pi from the installation directory), then /login. API-key providers also accept their usual environment variable. Auth file: ${config.authFile}`);
    }
  }
  if (stopping) return;
  instance = await openInstance({ ...config, models, configureAgent: !config.inspectOnly,
    onReport: report => console.error(`Pi Durable: ${report.error?.message ?? report.message ?? report.kind ?? 'runtime report'}`) });
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
      prompt += chunk;
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
    let line;
    try { line = (await reader.question('you> ', { signal: shutdown.signal })).trim(); }
    catch (error) { if (stopping || reader.closed) break; throw error; }
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') console.log('/history — saved messages\n/agents — spawned agents and whether they are busy\n/status — storage, memory and pending work\n/exit — close without discarding unfinished work\nAgents work in the background; their reports and Pi\'s replies print as they arrive.\nTools can only be changed by relaunching with or without --allow-tools.');
    else if (line === '/history') await printHistory();
    else if (line === '/agents') await printAgents();
    else if (line === '/status') await printStatus();
    else if (line.startsWith('/')) console.error('Unknown command. Use /help.');
    else {
      try { await send(line, undefined, { print: false }); }
      catch (error) { if (!stopping) console.error(`pi-durable: ${error.message}`); }
    }
  }
}

try { await main(); }
catch (error) { if (!stopping) { console.error(`pi-durable: ${error.message}`); process.exitCode = 1; } }
finally {
  watcher?.dispose();
  reader?.close();
  try { await close(); } catch (error) { console.error(`Closing failed: ${error.message}`); process.exitCode = 1; }
  try { cleanupSessionResources(); }
  catch (error) { console.error(`Transport cleanup failed: ${error.message}`); process.exitCode = 1; }
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
