import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shared } from '../../src/web/panels/cache.ts';

/** A fetch whose answer the test gives, counting calls. */
function deferred<V>(): { fetch: () => Promise<V>; calls: () => number; resolve: (value: V) => void; reject: (error: Error) => void } {
  let calls = 0;
  let resolve: (value: V) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  return {
    fetch: () => {
      calls++;
      return new Promise<V>((yes, no) => { resolve = yes; reject = no; });
    },
    calls: () => calls,
    resolve: value => resolve(value),
    reject: error => reject(error),
  };
}

test('a load joins the one in flight for its key, and the answer is kept', async () => {
  const cache = new Shared<string[]>();
  const source = deferred<string[]>();
  const warm = cache.load('m', source.fetch);
  const panel = cache.load('m', source.fetch);
  assert.equal(warm, panel);
  assert.equal(source.calls(), 1);
  assert.equal(cache.loading('m'), true);
  assert.equal(cache.get('m'), undefined);
  source.resolve(['low', 'high']);
  assert.deepEqual(await panel, ['low', 'high']);
  assert.deepEqual(cache.get('m'), ['low', 'high']);
  assert.deepEqual(cache.latest, ['low', 'high']);
  assert.equal(cache.loading('m'), false);
});

test('once settled, the next load asks again; other keys ask on their own', async () => {
  const cache = new Shared<string>();
  const source = deferred<string>();
  const first = cache.load('a', source.fetch);
  source.resolve('one');
  await first;
  const again = cache.load('a', source.fetch);
  assert.equal(source.calls(), 2);
  source.resolve('two');
  assert.equal(await again, 'two');
  const other = deferred<string>();
  const b = cache.load('b', other.fetch);
  assert.equal(other.calls(), 1);
  other.resolve('bee');
  await b;
  assert.equal(cache.get('a'), 'two');
  assert.equal(cache.get('b'), 'bee');
  assert.equal(cache.latest, 'bee');
});

test('a failure rejects every caller, keeps the value there, and lets the next load ask', async () => {
  const cache = new Shared<string>();
  const source = deferred<string>();
  const ok = cache.load('k', source.fetch);
  source.resolve('kept');
  await ok;
  const warm = cache.load('k', source.fetch).catch(() => 'swallowed');
  const panel = cache.load('k', source.fetch);
  source.reject(new Error('lost'));
  assert.equal(await warm, 'swallowed');
  await assert.rejects(panel, /lost/);
  assert.equal(cache.get('k'), 'kept');
  assert.equal(cache.loading('k'), false);
  const retry = cache.load('k', source.fetch);
  assert.equal(source.calls(), 3);
  source.resolve('fresh');
  assert.equal(await retry, 'fresh');
});

test('an answer `keep` refuses still reaches the callers but is not kept', async () => {
  const cache = new Shared<string>();
  const source = deferred<string>();
  let current = 'm1';
  const levels = cache.load('m1', source.fetch, () => current === 'm1');
  current = 'm2';
  source.resolve('either model');
  assert.equal(await levels, 'either model');
  assert.equal(cache.get('m1'), undefined);
  assert.equal(cache.latest, undefined);
});
