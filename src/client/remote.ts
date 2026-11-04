// Remote routing happens before resolving the local database, models or credentials.
import { realpath } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Options } from '../host/config.ts';
import { CLIENT, runAttached } from './attach.ts';
import { ENABLE_TOOLS } from '../protocol/messages.ts';
import type { MachineTarget } from '../protocol/machines.ts';
import { clientConfigPath, machineId, readClientConfig, remoteTarget, saveClientConfig, validateTarget } from './config.ts';
import { RemoteSession } from './remote-session.ts';
import { sshConnector } from './ssh-link.ts';
import { ClientLink } from './unix-link.ts';
import { errorMessage } from '../protocol/util.ts';

/** Saves preferences, or runs the SSH TUI; undefined is the only route to local configuration. */
export async function remoteChat(options: Options, env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  if (options.command === 'connect') {
    const host = options.remote;
    if (host === undefined) throw new Error('connect requires an SSH host');
    const target = validateTarget({ host, ...options.remoteBin !== undefined ? { command: options.remoteBin } : {},
      ...options.remoteDataDir !== undefined ? { dataDir: options.remoteDataDir } : {} });
    const saved = await readClientConfig(env);
    await saveClientConfig({ machineId: await machineId(env, saved), ssh: target }, env);
    console.log(`Configured remote server ${target.host}. Run pi-durable to connect; --local opens the local chat.`);
    return 0;
  }
  const selected = await remoteTarget(options, env);
  if (selected === undefined) return undefined;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Remote chat needs a terminal (stdin and stdout); use --local for local noninteractive modes');
  // Validate the tools directory locally, never by resolving local chat state.
  // Local launches and the stdio bridge must not load tool implementations or a model catalog.
  const [cwd, id, [{ MachineExecutor }, { sshKeys }, { startSshAgent }]] = await Promise.all([
    realpath(resolve(options.cwd ?? process.cwd())), machineId(env, selected.saved),
    Promise.all([import('./machine-executor.ts'), import('../runtime/guard.ts'), import('../runtime/ssh-agent.ts')])]);
  const link = new ClientLink({ connect: sshConnector(selected.target), client: CLIENT, helloMs: 15_000, reconnectNormal: true });
  const target: MachineTarget = { machineId: id, cwd, label: hostname() };
  let enabled = options.remoteAllowTools === true;
  // Pi's own SSH agent for the tools here (ADR 0030); its warnings wait for the TUI.
  const agentWarnings: string[] = [];
  const sshAgent = await startSshAgent(sshKeys(env), warning => agentWarnings.push(warning), env);
  const executor = new MachineExecutor({ target, enabled, env, protectedPaths: [dirname(clientConfigPath(env))], sshAgent: sshAgent?.socket,
    ledgerDir: join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-durable', 'machine-tools') });
  const session = new RemoteSession(link, { clientId: `tui-${crypto.randomUUID()}`, target, requireMachines: true,
    machineToolsEnabled: () => enabled,
    setMachineTools: async next => {
      enabled = next;
      executor.setEnabled(next);
      await session.request('machine.set', next ? { enabled: true, confirm: ENABLE_TOOLS } : { enabled: false });
    } });
  let registered: Promise<unknown> = Promise.resolve();
  const off = link.onMessage(message => {
    if (message.t === 'ready') {
      registered = session.request('machine.register', { registration: { target, enabled } });
      registered.catch((error: unknown) => {
        session.notify(errorMessage(error), 'error');
        link.close();
      });
    } else if (message.t === 'machine.call') {
      void executor.execute(message).catch((error: unknown) => ({ isError: true,
        output: [{ type: 'text' as const, text: errorMessage(error) }] }))
        .then(result => { link.send({ t: 'machine.result', id: message.id, result }); });
    } else if (message.t === 'machine.cancel') executor.cancel(message.id);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => { await link.start(); await session.ready(); })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Remote server did not become ready within 30 seconds')), 30_000);
      }),
    ]);
    clearTimeout(timer);
    await registered;
    for (const warning of agentWarnings) session.notify(warning, 'warn');
    if (enabled) await session.setTools(true);
    return await runAttached(session, { cwd, initialNotice: `Shared chat: ${selected.target.host}. Tools execute on ${target.label}: ${cwd}.` });
  } finally {
    clearTimeout(timer);
    off();
    await executor.close();
    await sshAgent?.close();
    await session.close();
  }
}
