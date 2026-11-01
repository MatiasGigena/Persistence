import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { sshConnector, SSH_SERVER_LINE_MAX } from '../../src/client/ssh-link.ts';
import type { SshSpawn } from '../../src/client/ssh-link.ts';
import { ClientLink } from '../../src/client/unix-link.ts';
import type { ChannelEvents } from '../../src/client/unix-link.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';

const WELCOME = JSON.stringify({ t: 'welcome', protocol: PROTOCOL, server: '0.1.0', boot: 'b', assets: 'a', peer: 'socket',
  cwd: '/wé🚤', tools: { remote: 'confirm', idleMinutes: 30 } });

function fixture(script: string): { spawn: SshSpawn; children: ChildProcessWithoutNullStreams[]; calls: string[][] } {
  const children: ChildProcessWithoutNullStreams[] = [], calls: string[][] = [];
  return {
    children, calls,
    spawn(command, args, options) {
      calls.push([command, ...args]);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      const child = spawn(process.execPath, ['-e', script], options);
      children.push(child);
      return child;
    },
  };
}

function sink(): { events: ChannelEvents; lines: string[]; ended: Promise<void>; ends: () => number } {
  const lines: string[] = [];
  let count = 0;
  const done = Promise.withResolvers<void>();
  return { lines, ended: done.promise, ends: () => count,
    events: { message: line => lines.push(line), end: () => { count++; done.resolve(); } } };
}

const echoWelcome = `process.stdin.once('data', () => {
  const bytes = Buffer.from(${JSON.stringify(`${WELCOME}\n{"t":"ready"}\n`)});
  let at = 0;
  const send = () => { if (at === bytes.length) return; process.stdout.write(bytes.subarray(at, ++at)); setImmediate(send); };
  send();
});`;

test('SSH uses strict noninteractive arguments and quotes every remote word, not a shell command', async () => {
  const fake = fixture(echoWelcome);
  const connect = sshConnector({ host: 'me@vps-alias', command: "/opt/pi's app/pi-durable", dataDir: "/state/a'$(touch nope)" }, fake);
  const link = new ClientLink({ connect, client: 'test' });
  assert.equal((await link.start()).cwd, '/wé🚤');
  const args = fake.calls[0] ?? assert.fail('no ssh spawn');
  assert.deepEqual(args, ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '--', 'me@vps-alias',
    "'/opt/pi'\\''s app/pi-durable' 'bridge' '--data-dir' '/state/a'\\''$(touch nope)'"]);
  const exited = once(fake.children[0] ?? assert.fail('no child'), 'close');
  link.close();
  await exited;
});

test('SSH validates destinations, executable, paths and timeout configuration before spawning', () => {
  for (const host of ['', '-oProxyCommand=evil', 'user@-host', 'two hosts', 'host;evil', 'ssh://host', 'host:22', 'abc:22', '[::1', '::1]', 'a@b@c', 'host\n']) {
    assert.throws(() => sshConnector({ host }), /Invalid SSH host/);
  }
  for (const host of ['vps', 'user@example.com', '192.0.2.1', '[::1]', 'me@2001:db8::1']) {
    assert.doesNotThrow(() => sshConnector({ host }));
  }
  for (const command of ['', ' ', '-exec', 'pi\nother', 'pi\0']) assert.throws(() => sshConnector({ host: 'vps', command }), /command/);
  for (const dataDir of ['', ' ', '-bad', '/a\0']) assert.throws(() => sshConnector({ host: 'vps', dataDir }), /directory/);
  for (const startupMs of [0, NaN, 120_001]) assert.throws(() => sshConnector({ host: 'vps' }, { startupMs }), /timeout/);
});

test('ClientLink.start reports concrete, bounded sanitized SSH stderr (auth, host key, missing remote executable)', async () => {
  for (const message of ['Permission denied (publickey).', 'Host key verification failed.', 'sh: pi-durable: not found']) {
    const fake = fixture(`process.stdin.once('data', () => { process.stderr.write('\x1b[31m' + ${JSON.stringify(message)} + '\x1b[0m\\n'); process.exitCode = 127; process.stdin.destroy(); });`);
    const link = new ClientLink({ connect: sshConnector({ host: 'vps' }, fake), client: 'test' });
    await assert.rejects(link.start(), error => error instanceof Error && error.message.includes(message) && !error.message.includes('\x1b'));
  }
  // Each common failure says how to fix it: the connector never prompts and never accepts a host key itself.
  for (const [message, code, fix] of [
    ['Permission denied (publickey).', 255, /without prompts.*key-based login for me@vps/],
    ['No ED25519 host key is known for vps and you have requested strict checking.\r\nHost key verification failed.', 255, /Run ssh me@vps once/],
    ['bash: line 1: pi-durable: command not found', 127, /not on the remote PATH.*--remote-bin/],
  ] as const) {
    const fake = fixture(`process.stderr.write(${JSON.stringify(message)}); process.exitCode = ${code};`);
    const link = new ClientLink({ connect: sshConnector({ host: 'me@vps' }, fake), client: 'test' });
    await assert.rejects(link.start(), error => error instanceof Error && fix.test(error.message));
  }
  const fake = fixture("process.stderr.write('failure '.repeat(5000)); process.exitCode = 1;");
  const target = sink();
  await sshConnector({ host: 'vps' }, fake)(target.events);
  await target.ended;
  assert.ok((target.lines[0]?.length ?? 0) < 1200);
  assert.equal(target.ends(), 1);
});

test('missing local ssh rejects and a silent startup is bounded and reaped', async () => {
  const missing: SshSpawn = (_command, _args, options) => spawn('/nonexistent/pi-durable-test-ssh', [], options);
  await assert.rejects(sshConnector({ host: 'vps' }, { spawn: missing })(sink().events), /ENOENT/);
  const fake = fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const link = new ClientLink({ connect: sshConnector({ host: 'vps' }, { ...fake, startupMs: 150, killMs: 30 }), client: 'test', helloMs: 1000 });
  const started = link.start();
  const child = fake.children[0] ?? assert.fail('no child');
  const exited = once(child, 'close');
  await assert.rejects(started, /did not answer hello/);
  await exited;
  assert.notEqual(child.signalCode, null);
});

test('SSH rejects an oversized unterminated server line without unbounded buffering', async () => {
  const fake = fixture(`process.stdin.once('data', () => process.stdout.write('x'.repeat(${SSH_SERVER_LINE_MAX + 1})));`);
  const link = new ClientLink({ connect: sshConnector({ host: 'vps' }, fake), client: 'test', helloMs: 5000 });
  await assert.rejects(link.start(), /line limit/);
});

test('write backpressure is bounded; close and cancellation notify exactly once and reap children', async () => {
  const fake = fixture('setInterval(() => {}, 1000);');
  const target = sink();
  const channel = await sshConnector({ host: 'vps' }, { ...fake, killMs: 20 })(target.events);
  const child = fake.children[0] ?? assert.fail('no child');
  const exited = once(child, 'close');
  // A stopped reader must not let many individually valid messages form an unbounded writable queue.
  for (let n = 0; n < 20; n++) channel.send('x'.repeat(1024 * 1024));
  channel.close();
  channel.close();
  await target.ended;
  await exited;
  assert.match(target.lines[0] ?? '', /write buffer limit/);
  assert.equal(target.ends(), 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sshConnector({ host: 'vps' }, { ...fake, signal: controller.signal })(sink().events), /cancelled/);
  assert.equal(fake.children.length, 1);

  const active = new AbortController(), other = sink();
  await sshConnector({ host: 'vps' }, { ...fake, signal: active.signal })(other.events);
  const next = fake.children[1] ?? assert.fail('no second child');
  const cancelled = once(next, 'close');
  active.abort();
  await cancelled;
  assert.equal(other.ends(), 1);
  await delay(5);
  assert.equal(other.ends(), 1);
});

test('malformed/unknown lines and blank lines are safely ignored by ClientLink', async () => {
  const fake = fixture(`process.stdin.once('data', () => { process.stdout.write('not json\\n{\\n{\"t\":\"future\"}\\n\\r\\n' + ${JSON.stringify(`${WELCOME}\n`)}); });`);
  const link = new ClientLink({ connect: sshConnector({ host: 'vps' }, fake), client: 'test' });
  assert.equal((await link.start()).cwd, '/wé🚤');
  const exited = once(fake.children[0] ?? assert.fail('no child'), 'close');
  link.close();
  await exited;
});

test('remote bye is not overwritten by local SSH failure diagnostics', async () => {
  const fake = fixture(`process.stdin.once('data', () => { process.stdout.write('{"t":"bye","code":4000,"reason":"update required"}\\n'); process.stdin.destroy(); });`);
  await assert.rejects(new ClientLink({ connect: sshConnector({ host: 'vps' }, fake), client: 'test' }).start(), /update required.*Update pi-durable/);
});
