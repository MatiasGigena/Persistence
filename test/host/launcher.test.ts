import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('the launcher names the Node.js it needs instead of running an old one, or none', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-launcher-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  // A PATH with only what the launcher needs besides node; HOME has no pi-node fallback.
  const bin = join(folder, 'bin');
  await mkdir(bin);
  for (const tool of ['readlink', 'dirname']) await symlink(`/usr/bin/${tool}`, join(bin, tool));
  const launch = () => spawnSync('/bin/bash', [resolve('bin/pi-durable'), '--version'],
    { encoding: 'utf8', env: { HOME: folder, PATH: bin } });
  const none = launch();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^pi-durable: Node\.js >=22\.19\.0 is required \(found: none\); install it, or set PI_DURABLE_NODE\n$/);
  // An old node: fails the launcher's version check, and would fail on the .ts entry point.
  await writeFile(join(bin, 'node'), '#!/bin/sh\n[ "$1" = --version ] && echo v20.11.0 && exit 0\n[ "$1" = -e ] && exit 1\necho "Unknown file extension .ts" >&2\nexit 1\n');
  await chmod(join(bin, 'node'), 0o755);
  const old = launch();
  assert.equal(old.status, 1);
  assert.match(old.stderr, /^pi-durable: Node\.js >=22\.19\.0 is required \(found: v20\.11\.0\)/);
  assert.doesNotMatch(old.stderr, /Unknown file extension/);
});
