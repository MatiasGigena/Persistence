// The attached TUI against the real server: `serve` with a faux model in a child process (test/fixtures/serve-faux.ts),
// and the TUI in this process on a fake terminal, as `pi-durable` runs it when a server answers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { attachChat, DETACHED, serverAnswers } from '../../src/client/attach.ts';
import { parseArgs, resolveOptions } from '../../src/host/config.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

class FakeTerminal implements Terminal {
  output = '';
  readonly columns = 100;
  readonly rows = 30;
  private onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void {}
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output += data; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  type(...keys: string[]): void {
    if (!this.onInput) throw new Error('terminal not started');
    for (const key of keys) for (const data of key.length > 1 && !key.startsWith('\x1b') ? [...key] : [key]) this.onInput(data);
  }
  text(): string { return stripTerminalSequences(this.output); }
  /** The screen's rows: the renderer writes each row as "move to row;1, clear the line, the line". */
  screen(): string[] {
    const rows = Array.from({ length: this.rows }, () => '');
    const parts = this.output.split(/\x1b\[(\d+);1H\x1b\[2K/);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      rows[Number(parts[i]) - 1] = stripTerminalSequences((parts[i + 1] ?? '').split(/\x1b\[\d+;\d+H/)[0] ?? '');
    }
    return rows;
  }
  /** The footer row (the header above the chat says "tools off" too). */
  footer(): string { return this.screen().findLast(row => row.includes('tools off')) ?? ''; }
}

async function until(ok: () => boolean, what: () => string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what()}`);
    await delay(20);
  }
}

test('attach to serve: send, see the reply stream in, survive a restart, detach, and the server keeps running', { timeout: 90_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pd-attach-e2e-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const database = join(folder, 'chat.sqlite');
  const { model } = offlineModels();
  const serveConfig = await resolveOptions(parseArgs(['serve', '--database', database, '--cwd', folder,
    '--model', `${model.provider}/${model.modelId}`]), {});
  const start = async () => {
    const child = spawn(process.execPath, [resolve('test/fixtures/serve-faux.ts'), JSON.stringify(serveConfig)], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    let log = '';
    child.stderr.on('data', chunk => { log += String(chunk); });
    const exited = new Promise<number | null>(done => child.once('exit', code => done(code)));
    await until(() => log.includes('ready:'), () => log);
    return { child, exited };
  };
  const first = await start();

  const config = await resolveOptions(parseArgs(['--database', database]), {});
  const terminal = new FakeTerminal();
  const printed: string[] = [];
  const stop = new AbortController();
  t.after(() => { stop.abort(); return Promise.resolve(); });
  const done = attachChat(config, { tty: { stdin: true, stdout: true }, terminal, env: {}, signal: stop.signal, print: line => printed.push(line) });
  await until(() => terminal.text().includes('tools off'), () => terminal.text());
  terminal.type('How many boats?', '\r');
  await until(() => terminal.text().includes('all of them blue.'), () => terminal.text());

  // A restart: bye 1012, "reconnecting…" while it is down, then a fresh snapshot from the new server.
  first.child.kill('SIGTERM');
  assert.equal(await first.exited, 143);
  await until(() => terminal.footer().includes('reconnecting…'), () => terminal.screen().join('\n'));
  const second = await start();
  await until(() => terminal.text().includes('The server restarted.') && !terminal.footer().includes('reconnecting'),
    () => terminal.screen().join('\n'));
  terminal.type('Count again', '\r');
  await until(() => terminal.screen().some(row => row.includes('Count again')), () => terminal.screen().join('\n'));

  terminal.type('\x04');
  assert.equal(await done, 0);
  assert.deepEqual(printed, [DETACHED]);
  assert.equal(second.child.exitCode, null, 'the server keeps running');
  assert.equal(await serverAnswers(config.socketPath), true);
  second.child.kill('SIGTERM');
  assert.equal(await second.exited, 143);
});
