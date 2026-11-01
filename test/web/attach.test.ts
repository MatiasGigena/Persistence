import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inOrder } from '../../src/web/format.ts';

const later = <T>(ms: number, value: T, fail = false): Promise<T> =>
  new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error(String(value))) : resolve(value)), ms));

test('images read at once are attached in the order they were picked, not as their reads finish', async () => {
  const got: string[] = [];
  // The first picked is the slowest to read (a big photo), and the third fails.
  const times = new Map([['a', 40], ['b', 5], ['c', 20], ['d', 1]]);
  const first = inOrder(['a', 'b', 'c', 'd'], name => later(times.get(name) ?? 0, name, name === 'c'), result => {
    got.push(result.ok ? result.value : `failed ${String(result.error instanceof Error ? result.error.message : '')}`);
  });
  // A second pick while the first is read lands after it.
  const second = inOrder(['e'], name => later(0, name), result => { got.push(result.ok ? result.value : 'failed'); }, first);
  await second;
  assert.deepEqual(got, ['a', 'b', 'failed c', 'd', 'e']);
});
