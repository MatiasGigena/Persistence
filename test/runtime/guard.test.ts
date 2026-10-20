import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { GuardedEnv, protection } from '../../src/runtime/guard.ts';
import type { Protection } from '../../src/runtime/guard.ts';
import { answerText, openInstance, transcript } from '../../src/runtime/runtime.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const context = BACKGROUND_CONTEXT;
const hasBwrap = (() => {
  try { execFileSync('bwrap', ['--dev-bind', '/', '/', '--', '/bin/sh', '-c', 'true'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** A home with a key, a chat state folder, a read-only folder, and a work folder; the env works in `work`. */
async function world(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), work = join(home, 'work'), state = join(home, 'state'), system = join(root, 'system');
  for (const dir of [join(home, '.ssh'), work, join(state, 'chat.unii'), system]) await mkdir(dir, { recursive: true });
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'SECRET KEY');
  await writeFile(join(state, 'chat.sqlite'), 'db');
  await writeFile(join(home, '.netrc'), 'machine x password y');
  await writeFile(join(system, 'config'), 'system file');
  await writeFile(join(work, 'notes.txt'), 'hello');
  await symlink(join(home, '.ssh'), join(work, 'keys'));
  const guarded: Protection = { hidden: [state, join(state, 'chat.sqlite'), join(home, '.ssh'), join(home, '.netrc')], readOnly: [system] };
  return { root, home, work, state, system, env: new GuardedEnv({ cwd: work, protection: guarded }) };
}

test('protection(): the chat state and credentials hidden, system read-only, adjustable by env', () => {
  const state = { dataDir: '/s', databasePath: '/s/chat.sqlite', memoryDir: '/s/chat.unii', settingsPath: '/s/settings.json',
    serveDir: '/s/serve', socketPath: '/run/u/pd.sock', authFile: '/h/.pi/agent/auth.json' };
  const { hidden, readOnly } = protection(state, {}, '/h');
  for (const path of ['/s', '/s/chat.sqlite-wal', '/s/chat.sqlite.lock', '/s/chat.unii', '/s/backups', '/run/u/pd.sock',
    '/h/.ssh', '/h/.claude', '/h/.pi/agent/auth.json', '/h/.config/gh', '/h/.git-credentials']) assert.ok(hidden.includes(path), path);
  assert.ok(readOnly.includes('/etc') && readOnly.includes('/usr') && readOnly.includes('/boot'));
  const custom = protection(state, { PI_DURABLE_PROTECT: '~/secrets:/data/keys', PI_DURABLE_UNPROTECT: '~/.ssh:/opt' }, '/h');
  assert.ok(custom.hidden.includes('/h/secrets') && custom.hidden.includes('/data/keys'));
  assert.ok(!custom.hidden.includes('/h/.ssh'), 'unprotected');
  assert.ok(!custom.readOnly.includes('/opt'));
});

test('read, write and edit operations: hidden paths refused, symlinks followed, the rest untouched', async t => {
  const { env, home, state, work } = await world(t);
  const refused = async (result: Promise<{ ok: boolean; error?: unknown }>, what: string) => {
    const value = await result;
    assert.equal(value.ok, false, what);
    assert.match(String(value.error), /is protected/, what);
  };
  await refused(env.readTextFile(join(home, '.ssh', 'id_ed25519'), context), 'a key');
  await refused(env.readTextFile('keys/id_ed25519', context), 'through a symlink');
  await refused(env.readTextFile('../.netrc', context), 'a relative path');
  await refused(env.listDir(join(home, '.ssh'), context), 'listing');
  await refused(env.writeFile(join(state, 'chat.sqlite'), 'gone', context), 'the database');
  await refused(env.writeFile(join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA', context), 'a new file inside');
  await refused(env.remove(state, { recursive: true }, context), 'the state folder');
  await refused(env.remove(home, { recursive: true, force: true }, context), 'a folder that contains protected ones');
  await refused(env.renameFile(join(home, '.ssh'), join(work, 'stolen'), context), 'moving it out');
  assert.equal(await readFile(join(state, 'chat.sqlite'), 'utf8'), 'db');

  const read = await env.readTextFile('notes.txt', context);
  assert.deepEqual(read, { ok: true, value: 'hello' });
  assert.equal((await env.writeFile('out.txt', 'made', context)).ok, true);
  assert.equal(await readFile(join(work, 'out.txt'), 'utf8'), 'made');
  assert.equal((await env.remove('out.txt', undefined, context)).ok, true);
});

test('read-only paths: read allowed, writes refused', async t => {
  const { env, system } = await world(t);
  assert.deepEqual(await env.readTextFile(join(system, 'config'), context), { ok: true, value: 'system file' });
  const write = await env.writeFile(join(system, 'config'), 'changed', context);
  assert.equal(write.ok, false);
  assert.match(String(!write.ok && write.error), /read-only/);
});

test('bash runs in bubblewrap: hidden folders empty, files unreadable, read-only folders unwritable, work as usual', { skip: !hasBwrap && 'bwrap is not installed' }, async t => {
  const { env, home, state, system, work } = await world(t);
  const run = async (command: string) => {
    let out = '';
    const result = await env.exec(command, { onOutput: text => { out += text; } }, context);
    assert.ok(result.ok, String(!result.ok && result.error));
    return { out, code: result.value.exitCode };
  };
  assert.equal((await run(`cat ${join(home, '.ssh', 'id_ed25519')} 2>&1; ls -A ${join(home, '.ssh')} | wc -l`)).out.trim().split('\n').at(-1), '0');
  assert.doesNotMatch((await run(`cat ${join(home, '.netrc')} 2>&1`)).out, /password/, 'a hidden file cannot be read');
  assert.notEqual((await run(`echo x > ${join(system, 'config')}`)).code, 0, 'read-only');
  assert.equal(await readFile(join(system, 'config'), 'utf8'), 'system file');
  assert.equal((await run(`ls -A ${state} | wc -l`)).out.trim(), '0', 'a hidden folder is empty, names included');
  await run(`rm -rf ${state}/chat.unii; echo y > ${state}/chat.sqlite`);
  assert.equal(await readFile(join(state, 'chat.sqlite'), 'utf8'), 'db', 'changes inside a hidden folder never reach it');
  const { out } = await run('echo made > out.txt && cat notes.txt out.txt && pwd');
  assert.equal(out, `hellomade\n${work}\n`);
});

test('without a working bubblewrap, bash refuses and says how to fix it', async t => {
  const { work } = await world(t);
  const env = new GuardedEnv({ cwd: work, protection: { hidden: [], readOnly: [] }, bwrap: join(work, 'no-bwrap') });
  const result = await env.exec('echo hi', undefined, context);
  assert.equal(result.ok, false);
  assert.match(String(!result.ok && result.error.message), /bash is off: .*not installed\. Install bubblewrap \(sudo apt install bubblewrap\)/);
});

test('through the Harness: Pi\'s own read and bash tools are held to the protection', { skip: !hasBwrap && 'bwrap is not installed' }, async t => {
  const { home, work, state } = await world(t);
  const key = join(home, '.ssh', 'id_ed25519');
  const catalog = offlineModels([
    fauxAssistantMessage([fauxToolCall('read', { path: key }, { id: 'r1' }), fauxToolCall('bash', { command: `cat ${key}; ls ${work}` }, { id: 'b1' })],
      { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  const instance = await openInstance({ databasePath: join(state, 'chat.sqlite.test'), cwd: work, allowTools: true, ...catalog,
    protection: { hidden: [join(home, '.ssh')], readOnly: [] } });
  let results: string[];
  try {
    const submission = await instance.root.submit({ type: 'input', content: 'show me the key' }, instance.context);
    assert.equal(await answerText(instance.root, await submission.wait(instance.context), instance.context), 'done');
    results = (await transcript(instance.root, instance.context)).flatMap(entry => entry.model ?? [])
      .filter(message => message.role === 'toolResult')
      .map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''));
  } finally {
    await instance.close();
  }
  assert.equal(results.length, 2);
  assert.ok(results.every(text => !text.includes('SECRET KEY')), JSON.stringify(results));
  assert.match(results.join('\n'), /is protected/);
  assert.match(results.join('\n'), /notes\.txt/, 'bash itself ran');
});
