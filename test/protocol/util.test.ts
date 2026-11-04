import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutBytes, int, list, obj, optNum, ShapeError, str } from '../../src/protocol/util.ts';

test('cutBytes keeps whole characters within the byte limit', () => {
  assert.equal(cutBytes('hello', 10), 'hello');
  assert.equal(cutBytes('hello', 3), 'hel');
  assert.equal(cutBytes('aé', 2), 'a', 'é takes two bytes: half of it is dropped');
  assert.equal(cutBytes('a😀b', 4), 'a', 'never half a surrogate pair');
  assert.equal(cutBytes('a😀b', 5), 'a😀');
});

test('the narrowers return the field or throw a ShapeError naming it', () => {
  const o = obj({ name: 'x', n: 2, items: [1, 2] }, 'thing');
  assert.equal(str(o, 'name'), 'x');
  assert.equal(int(o, 'n', 1), 2);
  assert.equal(optNum(o, 'missing'), undefined);
  assert.deepEqual(list(o, 'items', (x, i) => `${String(x)}@${i}`), ['1@0', '2@1']);
  assert.throws(() => obj([], 'thing'), (error: unknown) => error instanceof ShapeError && error.message === 'thing must be an object');
  assert.throws(() => str(o, 'n'), /n must be a string/);
  assert.throws(() => int(o, 'n', 3), /n must be an integer >= 3/);
});
