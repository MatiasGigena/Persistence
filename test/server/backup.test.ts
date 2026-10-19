import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { answerText, openInstance, transcript } from '../../src/runtime/runtime.ts';
import { backup, backupOffline, backupRoot, KEEP_MS, prune, stamp, stampTime } from '../../src/server/backup.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const DAY = 24 * 60 * 60 * 1000;

test('stamps sort by time and read back', () => {
  const date = new Date('2026-10-19T03:04:05.678Z');
  assert.equal(stamp(date), '2026-10-19T03-04-05Z');
  assert.equal(stampTime(stamp(date)), Date.parse('2026-10-19T03:04:05Z'));
  assert.equal(stampTime(`${stamp(date)}-2`), Date.parse('2026-10-19T03:04:05Z'));
  assert.equal(stampTime('notes'), undefined);
});

test('an online backup of an open chat opens as the same chat', { timeout: 30_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-backup-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const databasePath = join(folder, 'chat.sqlite'), memoryDir = join(folder, 'chat.unii'), settingsPath = join(folder, 'settings.json');
  await writeFile(settingsPath, '{"model":"faux/faux-1"}\n');
  const catalog = offlineModels([fauxAssistantMessage('Three boats.')]);
  const instance = await openInstance({ databasePath, cwd: folder, ...catalog });
  let path: string, bytes: number;
  try {
    const submission = await instance.root.submit({ type: 'input', content: 'Count the boats.' }, instance.context);
    assert.equal(await answerText(instance.root, await submission.wait(instance.context), instance.context), 'Three boats.');
    ({ path, bytes } = await backup({ databasePath, memoryDir, settingsPath }, instance.exclusive, { now: new Date('2026-10-19T03:00:00Z') }));
  } finally {
    await instance.close();
  }
  assert.equal(path, join(backupRoot(databasePath), '2026-10-19T03-00-00Z'));
  assert.deepEqual((await readdir(path)).sort(), ['chat.sqlite', 'chat.unii', 'settings.json']);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.ok(bytes > (await stat(join(path, 'chat.sqlite'))).size, 'the size counts the memory too');
  assert.ok((await readdir(join(path, 'chat.unii'))).includes('main'));

  const copy = await openInstance({ databasePath: join(path, 'chat.sqlite'), cwd: folder, ...offlineModels() });
  try {
    const texts = (await transcript(copy.root, copy.context)).flatMap(entry => entry.model ?? [])
      .flatMap(message => typeof message.content === 'string' ? [message.content]
        : message.content.flatMap(block => block.type === 'text' ? [block.text] : []));
    assert.ok(texts.includes('Count the boats.') && texts.includes('Three boats.'), JSON.stringify(texts));
    assert.ok((copy.memory?.status().messages ?? 0) >= 2, 'the memory came along');
  } finally {
    await copy.close();
  }

  // Without a server: a direct open, into --out, and a second backup in the same second gets its own directory.
  const out = join(folder, 'elsewhere');
  const now = new Date('2026-10-19T04:00:00Z');
  const first = await backupOffline({ databasePath, memoryDir, settingsPath }, { out, now });
  const second = await backupOffline({ databasePath, memoryDir, settingsPath }, { out, now });
  assert.deepEqual([first.path, second.path], [join(out, '2026-10-19T04-00-00Z'), join(out, '2026-10-19T04-00-00Z-2')]);
  const database = new DatabaseSync(join(second.path, 'chat.sqlite'), { readOnly: true });
  try { assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); } finally { database.close(); }
  await assert.rejects(backupOffline({ databasePath: join(folder, 'none.sqlite'), memoryDir, settingsPath }), /No chat to back up/);
});

test('pruning removes stamped backups older than 14 days and nothing else', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-10-19T03:00:00Z');
  const names = [stamp(new Date(now - KEEP_MS - DAY)), `${stamp(new Date(now - 20 * DAY))}-2`, stamp(new Date(now - 13 * DAY)),
    stamp(new Date(now)), 'notes', '1999-01-01'];
  for (const name of names) await mkdir(join(root, name));
  assert.deepEqual((await prune(root, { now })).sort(), names.slice(0, 2).sort());
  assert.deepEqual((await readdir(root)).sort(), names.slice(2).sort());
  assert.deepEqual(await prune(join(root, 'missing'), { now }), []);
});
