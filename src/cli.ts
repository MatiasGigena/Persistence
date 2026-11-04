#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachChat, serverAnswers, SERVER_RUNS } from './client/attach.ts';
import { bridge } from './client/bridge.ts';
import { remoteChat } from './client/remote.ts';
import { HELP, VERSION, parseArgs, resolveOptions } from './config/options.ts';
import { resolveSocketPath, statePaths } from './config/paths.ts';
import { errorCode, errorMessage } from './protocol/util.ts';
import type { Config } from './config/options.ts';
import { agentsCommand, backupOverSocket, devicesCommand, NoServer, pairCommand } from './client/admin.ts';
import { formatBytes } from './ui/text.ts';

/** `backup` through the running server; false when none answers (then the backup takes the flock itself). */
async function backupViaServer(config: Config): Promise<boolean> {
  try {
    const { path, bytes } = await backupOverSocket(config);
    console.log(`Backup written by the server: ${path} (${formatBytes(bytes)})`);
    return true;
  } catch (error) {
    if (error instanceof NoServer) return false;
    throw error;
  }
}

process.umask(0o077);
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); }
  else if (options.version) { console.log(`pi-durable ${VERSION} (SDK 1.5.0)`); }
  else {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js >=22.19.0 is required');
    // The bridge and SSH client must not resolve/create the local chat, load models or acquire its flock.
    const remote = options.command === 'bridge'
      ? await bridge(await resolveSocketPath(options)) : await remoteChat(options);
    if (remote !== undefined) process.exitCode = remote;
    else await localChat();

    async function localChat(): Promise<void> {
      const config = await resolveOptions(options);
      // An interactive launch attaches to a running server (ADR 0018); undefined means the chat opens here.
      const attached = await attachChat(config);
      if (attached !== undefined) process.exitCode = attached;
      else if (config.command === 'serve-pair') await pairCommand(config);
      else if (config.command === 'serve-devices') await devicesCommand(config);
      else if (config.command === 'serve-agents') await agentsCommand(config);
      else if (config.command === 'backup' && !config.exists) throw new Error(`No saved chat to back up at ${config.databasePath}`);
      else if (config.command === 'backup' && await backupViaServer(config)) { /* done by the server */ }
      else if (config.inspectOnly && !config.exists) {
        console.log(`No saved chat yet.\nDatabase: ${config.databasePath}`);
      } else {
        const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', '--no-fork', statePaths(config.databasePath).lock, process.execPath,
          fileURLToPath(new URL('./host/host.ts', import.meta.url)), JSON.stringify(config)], { stdio: 'inherit' });
        const listeners = new Map((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, () => child.kill(signal)]));
        for (const [signal, listener] of listeners) process.on(signal, listener);
        child.once('error', error => {
          console.error(errorCode(error) === 'ENOENT' ? 'pi-durable requires flock (util-linux on Linux).' : error.message);
          process.exitCode = 1;
        });
        const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve =>
          child.once('close', (...end) => resolve(end)));
        if (code === 75) {
          console.error(await serverAnswers(config.socketPath) ? SERVER_RUNS
            : 'This chat is already open in another pi-durable process. Close it first.');
        }
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
        for (const [signal, listener] of listeners) process.off(signal, listener);
      }
    }
  }
} catch (error) {
  console.error(`pi-durable: ${errorMessage(error)}`);
  process.exitCode = 1;
}
