import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { GuardedEnv, sshKeys } from '../../src/runtime/guard.ts';
import { startSshAgent } from '../../src/runtime/ssh-agent.ts';

const context = BACKGROUND_CONTEXT;
const has = (command: string, args: string[]): boolean => {
  try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { return false; }
};
const hasBwrap = has('bwrap', ['--dev-bind', '/', '/', '--', '/bin/sh', '-c', 'true']);
const hasAgent = has('sh', ['-c', 'command -v ssh-agent && command -v ssh-add && command -v ssh-keygen']);
// Short, unlike tmpdir() may be: a socket path has 107 bytes at most.
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', XDG_RUNTIME_DIR: '/tmp' };

/** A short folder with an unencrypted key, `plain`, and one with a passphrase, `locked`. */
async function keys(t: TestContext) {
  const dir = await mkdtemp('/tmp/pi-ssh-test-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plain = join(dir, 'plain'), locked = join(dir, 'locked');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'plain', '-f', plain]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'secret', '-C', 'locked', '-f', locked]);
  return { dir, plain, locked };
}

test('sshKeys(): PI_DURABLE_SSH_KEYS, :-separated, ~ the home directory', () => {
  assert.deepEqual(sshKeys({}, '/h'), []);
  assert.deepEqual(sshKeys({ PI_DURABLE_SSH_KEYS: '~/.ssh/a: /k/b ' }, '/h'), ['/h/.ssh/a', '/k/b']);
});

test('startSshAgent(): without keys, no agent', async () => {
  assert.equal(await startSshAgent([], () => assert.fail('no warning')), undefined);
});

test('startSshAgent(): holds the keys it could add, warns about one with a passphrase, close() removes it', { skip: !hasAgent && 'ssh-agent is not installed' }, async t => {
  const { plain, locked } = await keys(t);
  const warnings: string[] = [];
  const agent = await startSshAgent([plain, locked], message => warnings.push(message), env);
  assert.ok(agent);
  t.after(() => agent.close());
  const listed = execFileSync('ssh-add', ['-l'], { env: { ...env, SSH_AUTH_SOCK: agent.socket }, encoding: 'utf8' });
  assert.match(listed, /plain/);
  assert.doesNotMatch(listed, /locked/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], `PI_DURABLE_SSH_KEYS: ${locked} is not in Pi's SSH agent: it has a passphrase, which nothing can ask for here. Use a key without one.`);
  await agent.close();
  assert.equal(existsSync(agent.socket), false);
});

test('startSshAgent(): names why a key could not be added, a missing file or a file that is no key', { skip: !hasAgent && 'ssh-agent is not installed' }, async t => {
  const { dir, plain } = await keys(t);
  const missing = join(dir, 'id_typo'), notKey = `${plain}.pub.txt`;
  execFileSync('cp', ['/dev/null', notKey]);
  const warnings: string[] = [];
  const agent = await startSshAgent([missing, notKey, plain], message => warnings.push(message), env);
  assert.ok(agent);
  t.after(() => agent.close());
  assert.equal(warnings[0], `PI_DURABLE_SSH_KEYS: ${missing} is not in Pi's SSH agent: there is no such file.`);
  assert.match(warnings[1] ?? '', new RegExp(`^PI_DURABLE_SSH_KEYS: ${notKey} is not in Pi's SSH agent \\(.+\\)\\.$`));
  assert.doesNotMatch(warnings.join('\n'), /passphrase/, 'only a key with a passphrase is said to have one');
  assert.equal(warnings.length, 2);
});

test('startSshAgent(): without ssh-agent, warns and returns undefined', async () => {
  const warnings: string[] = [];
  assert.equal(await startSshAgent(['/k'], message => warnings.push(message), { PATH: '/nonexistent', XDG_RUNTIME_DIR: '/tmp' }), undefined);
  assert.match(warnings.join('\n'), /SSH agent is off, so bash has none: ssh-agent is not installed/);
});

test('bash sees Pi\'s SSH agent alone: the user\'s socket hidden, SSH_AUTH_SOCK replaced or removed', { skip: (!hasBwrap || !hasAgent) && 'bwrap or ssh-agent is not installed' }, async t => {
  const { dir, plain } = await keys(t);
  const pi = await startSshAgent([plain], () => undefined, env);
  const user = await startSshAgent([plain], () => undefined, env);
  assert.ok(pi && user);
  t.after(() => Promise.all([pi.close(), user.close()]));
  const run = async (sshAgent: string | undefined) => {
    const guarded = new GuardedEnv({ cwd: dir, protection: { hidden: [user.socket], readOnly: [], sshAgent } });
    let out = '';
    // The caller's environment names the user's agent, as the host's does.
    const result = await guarded.exec(`echo "sock=$SSH_AUTH_SOCK"; SSH_AUTH_SOCK=${user.socket} ssh-add -l 2>&1`,
      { env: { SSH_AUTH_SOCK: user.socket }, onOutput: text => { out += text; } }, context);
    assert.ok(result.ok, String(!result.ok && result.error));
    return out;
  };
  const withPi = await run(pi.socket);
  assert.match(withPi, new RegExp(`^sock=${pi.socket}\n`));
  assert.match(withPi, /Error connecting to agent/, 'the user\'s agent is unreachable');
  assert.match(await run(undefined), /^sock=\n/);
});
