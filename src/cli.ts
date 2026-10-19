#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { errorCode, errorMessage, HELP, VERSION, parseArgs, resolveOptions, statePaths } from './host/config.ts';
import type { Command } from './host/config.ts';

/** Commands not built yet, and the phase of docs/plans/server-and-web.md that builds each. */
const PENDING: Readonly<Partial<Record<Command, readonly [name: string, phase: number]>>> = {
  serve: ['serve', 2], backup: ['backup', 2], 'serve-pair': ['serve pair', 4], 'serve-devices': ['serve devices', 4],
};

process.umask(0o077);
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); }
  else if (options.version) { console.log(`pi-durable ${VERSION} (SDK 1.3.0)`); }
  else {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js >=22.19.0 is required');
    const config = await resolveOptions(options);
    const pending = PENDING[config.command] ?? (config.attach ? ['--attach', 3] : undefined);
    if (pending) throw new Error(`${pending[0]} is not implemented yet (phase ${pending[1]})`);
    if (config.inspectOnly && !config.exists) {
      console.log(`No saved session yet.\nDatabase: ${config.databasePath}`);
    } else {
      const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', '--no-fork', statePaths(config.databasePath).lock, process.execPath,
        fileURLToPath(new URL('./host/host.ts', import.meta.url)), JSON.stringify(config)], { stdio: 'inherit' });
      const listeners = new Map((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, () => child.kill(signal)]));
      for (const [signal, listener] of listeners) process.on(signal, listener);
      child.once('error', error => {
        console.error(errorCode(error) === 'ENOENT' ? 'pi-durable requires flock (util-linux on Linux).' : error.message);
        process.exitCode = 1;
      });
      await new Promise<void>(resolve => child.once('close', (code, signal) => {
        if (code === 75) console.error('This chat is already open in another pi-durable process. Close it first.');
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
        resolve();
      }));
      for (const [signal, listener] of listeners) process.off(signal, listener);
    }
  }
} catch (error) {
  console.error(`pi-durable: ${errorMessage(error)}`);
  process.exitCode = 1;
}
