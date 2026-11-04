import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import type { Interface } from 'node:readline/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai';
import type { ConversationView, ConversationWatch, EntryRecord } from '@earendil-works/pi-durable';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { protection, sandboxProblem } from '../runtime/guard.ts';
import { answerText, launchOptions, openInstance, reportText, transcript } from '../runtime/runtime.ts';
import type { Instance } from '../runtime/runtime.ts';
import { isWork, resumeInstance, settleAgents } from '../runtime/recovery.ts';
import { accessProblem, catalogProblem, checkAccess } from '../runtime/models.ts';
import { agentInputOf, assistantText, listAgents, text } from '../agents/index.ts';
import { claudeCliProvider } from '../providers/claude-cli.ts';
import { backupOffline } from '../server/backup.ts';
import { formatBytes } from '../ui/text.ts';
import { redirectConsole } from '../runtime/console.ts';
import { serve } from '../server/serve.ts';
import { createUiSession } from '../session/session.ts';
import { isCommand, runTui } from '../ui/tui/app.ts';
import { parseConfig } from '../config/options.ts';
import type { Config } from '../config/options.ts';
import { errorMessage } from '../protocol/util.ts';
import type { ModelSource } from '../config/options.ts';

// Internal entry point: src/cli.ts owns the database flock for this process.

/** An agent's report as its name and text: what the terminal UI shows, without the note to Pi its model text ends with. */
function reportOf(entry: EntryRecord): { name: string; text: string } | undefined {
  const input = agentInputOf(entry);
  return input?.kind === 'report' ? { name: input.from, text: input.text } : undefined;
}

async function printHistory({ root, context }: Instance, limit?: number): Promise<void> {
  const entries = await transcript(root, context);
  const messages = entries.flatMap(entry => (entry.model ?? []).map(message => ({ entry, message })))
    .filter(({ message }) => ['user', 'assistant'].includes(message.role) && text(message.content));
  for (const { entry, message } of limit ? messages.slice(-limit) : messages) {
    const report = reportOf(entry);
    if (report) console.log(`${report.name}: ${report.text}\n`);
    else console.log(`${message.role === 'user' ? 'You' : 'Pi'}: ${text(message.content)}\n`);
  }
  if (!messages.length) console.log('No messages saved yet.');
}

async function printStatus({ harness, root, context, memory }: Instance, config: Config): Promise<void> {
  const inspection = await harness.inspect(context);
  console.log(JSON.stringify({ database: config.databasePath, conversationId: root.id,
    model: `${config.model.provider}/${config.model.modelId}`, modelSource: config.modelSource,
    memory: memory?.status() ?? config.memoryDir,
    scheduler: inspection.scheduling, pendingTasks: inspection.tasks.length,
    pendingSubmissions: inspection.submissions.length }, null, 2));
}

async function resumePending(current: Instance): Promise<void> {
  const inspection = await current.harness.inspect(current.context);
  if (!inspection.tasks.length && !inspection.submissions.length) return;
  // A new chat's standing agents have an anchor task each: not work to report.
  const tasks = inspection.tasks.filter(isWork).length;
  const queued = inspection.submissions.length;
  const work = [tasks && `${tasks} pending task(s)`, queued && `${queued} queued message(s)`].filter(Boolean);
  if (work.length) console.error(`Resuming ${work.join(' and ')}…`);
  await resumeInstance(current);
}

async function printAgents({ harness, context }: Instance): Promise<void> {
  const agents = await listAgents(harness, context);
  for (const agent of agents) console.log(`${agent.name} (${agent.role}, parent ${agent.parent}) ${agent.busy ? 'busy' : 'idle'}`);
  if (!agents.length) console.log('No agents yet. Ask Pi to spawn one.');
}

// In chat, every committed reply of Pi is printed as it lands, including runs
// started by agents' reports, which no submission here waits for.
// `prompt` redraws the chat's prompt under a line printed while it waits for input.
async function watchReplies({ root, context }: Instance, prompt: () => void): Promise<ConversationWatch> {
  // The view's entries are a window (the newest, then appends): each one not seen yet is new.
  const view = await root.watch(context);
  const seen = new Set(view.value.entries.map(entry => entry.id));
  const show = (value: ConversationView): void => {
    for (const entry of value.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const report = reportOf(entry);
      const reply = entry.kind === 'pi.assistant' ? assistantText(entry) : '';
      const line = report ? `[${report.name}] ${report.text}` : reply && `pi> ${reply}`;
      if (!line) continue;
      process.stdout.write(`\r\x1b[K${line}\n\n`);
      prompt();
    }
  };
  view.start(call => {
    if (call.kind === 'value') show(call.value);
    return Promise.resolve();
  });
  return view;
}

async function send({ root, context }: Instance, prompt: string, requestId?: string, { print = true } = {}): Promise<void> {
  if (process.stderr.isTTY && print) console.error('Working…');
  const submission = await root.submit({ type: 'input', content: prompt,
    ...(requestId ? { requestId } : {}) }, context);
  const answer = await answerText(root, await submission.wait(context), context);
  if (print) console.log(answer);
}

// The terminal UI owns the screen while it runs: stray console output (runtime reports, memory
// warnings) becomes host notices, which the session hands to every client as chat notices.
async function chatTui(instance: Instance, config: Config, signal: AbortSignal): Promise<void> {
  const session = await createUiSession(instance, config);
  let restore = (): void => undefined;
  try {
    await runTui(session, { cwd: config.cwd, signal, onStart: () => { restore = redirectConsole(text => session.notify(text, 'warn')); } });
  } finally {
    restore();
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
async function checkModel(models: Models, config: Config, signal: AbortSignal): Promise<void> {
  const problem = catalogProblem(models, config.model) ?? accessProblem(config.model,
    await checkAccess(models, config.model.provider, { timeoutMs: 15_000, signal }), config.authFile);
  if (!problem) return;
  throw new Error(config.modelSource === 'settings'
    ? `${problem} (This model was saved by /model in ${config.settingsPath}; pass --model to launch with another.)` : problem);
}

/** Runs one launch of `config`: its state lives here, not in the module, so the entry below is the only side effect. */
async function runHost(config: Config): Promise<void> {
  let instance: Instance | undefined;
  let reader: Interface | undefined;
  let watcher: ConversationWatch | undefined;
  let stopping = false;
  // A send in progress: its reply prints mid-wait, and the chat loop prompts once the send returns.
  let sending = false;
  let closing: Promise<void> | undefined;
  const shutdown = new AbortController();
  const close = (): Promise<void> | undefined => closing ??= instance?.close();
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
      await checkModel(models, config, shutdown.signal);
    }
    if (stopping) return;
    // The server owns its Instance, and closes it after its clients got `bye`.
    if (config.command === 'serve') return serve(config, { models, signal: shutdown.signal });
    // The sandbox probe (it runs bwrap once) never rejects, and runs while the chat opens.
    const sandbox = config.allowTools && !config.inspectOnly ? sandboxProblem(protection(config)) : undefined;
    const opened = await openInstance({ ...launchOptions(config, models),
      onWarning: message => console.error(`Pi Durable: ${message}`), onReport: report => console.error(`Pi Durable: ${reportText(report)}`) });
    instance = opened;
    const problem = await sandbox;
    if (problem) console.error(`Coding tools: bash is off. ${problem}`);
    if (stopping) return;
    if (config.status) return printStatus(opened, config);
    if (config.history) return printHistory(opened);
    await resumePending(opened);
    if (stopping) return;
    if (config.resume) {
      if (process.stderr.isTTY) console.error('Waiting for agents to finish…');
      await settleAgents(opened, { signal: shutdown.signal });
      return printHistory(opened);
    }
    if (config.prompt !== undefined) return send(opened, config.prompt, config.requestId);
    if (!process.stdin.isTTY) {
      let prompt = '';
      for await (const chunk of process.stdin) {
        prompt += String(chunk);
        if (prompt.length > 4 * 1024 * 1024) throw new Error('Piped prompt exceeds 4 MiB');
      }
      if (!prompt.trim()) throw new Error('Supply a prompt, pipe text, or run in a terminal for interactive chat');
      return send(opened, prompt);
    }
    if (process.stdout.isTTY && !config.plain) return chatTui(opened, config, shutdown.signal);
    console.log(`Pi · one chat that never ends · ${config.model.provider}/${config.model.modelId} (${SOURCE[config.modelSource]})\nDatabase: ${config.databasePath}\nMemory: ${config.memoryDir}`);
    console.log(`Tools: ${config.allowTools ? 'ENABLED — your user permissions, minus the protected folders (chat state, credentials hidden; system read-only)' : 'OFF (--no-tools was given; relaunch without it to enable)'}\n/help for commands. /exit or Ctrl+C closes; unfinished work remains resumable.\n`);
    await printHistory(opened, 6);
    watcher = await watchReplies(opened, () => { if (!sending) reader?.prompt(true); });
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
      else if (line === '/history') await printHistory(opened);
      else if (line === '/agents') await printAgents(opened);
      else if (line === '/status') await printStatus(opened, config);
      else if (isCommand(line)) console.error(unknownCommand(line));
      else {
        sending = true;
        try { await send(opened, line, undefined, { print: false }); }
        catch (error) { if (!stopping) console.error(`pi-durable: ${errorMessage(error)}`); }
        finally { sending = false; }
      }
    }
  }

  try { await main(); }
  catch (error) { if (!stopping) { console.error(`pi-durable: ${errorMessage(error)}`); process.exitCode = 1; } }
  finally {
    await watcher?.stop();
    reader?.close();
    try { await close(); } catch (error) { console.error(`Closing failed: ${errorMessage(error)}`); process.exitCode = 1; }
    try { cleanupSessionResources(); }
    catch (error) { console.error(`Transport cleanup failed: ${errorMessage(error)}`); process.exitCode = 1; }
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

// Internal entry point: src/cli.ts owns the database flock for this process.
process.umask(0o077);
await runHost(parseConfig(process.argv[2]));
