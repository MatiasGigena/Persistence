import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { isRecord } from '../../src/protocol/util.ts';
import { SDK } from '../../src/runtime/sdk.ts';

const json = async (path: string | URL): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(isRecord(parsed));
  return parsed;
};

test('SDK is the release every Pi package is pinned at, and the one installed', async () => {
  const { dependencies } = await json(new URL('../../package.json', import.meta.url));
  assert.ok(isRecord(dependencies));
  const pins = Object.entries(dependencies).filter(([name]) => name.startsWith('@earendil-works/'));
  assert.ok(pins.length >= 7);
  for (const [name, version] of pins) assert.equal(version, SDK, `${name} is pinned at another release`);
  // What node_modules holds: a stale install would run another SDK than --version names.
  const installed = await json(createRequire(import.meta.url).resolve('@earendil-works/pi-durable/package.json'));
  assert.equal(installed.version, SDK);
});
