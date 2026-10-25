// The web app's first load follows one rule (format.ts loadStep): nothing new under 300ms, a skeleton until 1.5s,
// then the skeleton and a short line; offline skips the wait.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINK_TEXT, LOAD_QUIET_MS, LOAD_SLOW_MS, loadStep } from '../../src/web/format.ts';

test('a quick load shows nothing new, then a skeleton, then a skeleton with a line', () => {
  assert.deepEqual(loadStep(0, 'connecting'), { skeleton: false, text: '', retry: false });
  assert.deepEqual(loadStep(LOAD_QUIET_MS - 1, 'connecting'), { skeleton: false, text: '', retry: false });
  assert.deepEqual(loadStep(LOAD_QUIET_MS, 'connecting'), { skeleton: true, text: '', retry: false });
  assert.deepEqual(loadStep(LOAD_SLOW_MS - 1, 'connecting'), { skeleton: true, text: '', retry: false });
  assert.deepEqual(loadStep(LOAD_SLOW_MS, 'connecting'), { skeleton: true, text: LINK_TEXT.connecting.text, retry: false });
});

test('offline shows the skeleton and says so at once, with a retry', () => {
  assert.deepEqual(loadStep(0, 'offline'), { skeleton: true, text: LINK_TEXT.offline.text, retry: true });
});

test('a failed first attempt keeps the same marks, its line saying it is retrying', () => {
  assert.deepEqual(loadStep(50, 'reconnecting'), { skeleton: false, text: '', retry: false });
  assert.deepEqual(loadStep(LOAD_QUIET_MS, 'reconnecting'), { skeleton: true, text: '', retry: false });
  assert.deepEqual(loadStep(LOAD_SLOW_MS + 10, 'reconnecting'), { skeleton: true, text: LINK_TEXT.reconnecting.text, retry: true });
});

test('the marks keep their order and the lines differ, so no two say the same', () => {
  assert.ok(LOAD_QUIET_MS < LOAD_SLOW_MS);
  const texts = Object.values(LINK_TEXT).map(line => line.text);
  assert.equal(new Set(texts).size, texts.length);
});
