import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkStep, RECONNECT_BANNER_MS, RESTARTING } from '../../src/web/link-state.ts';
import type { LinkFacts } from '../../src/web/link-state.ts';
import { Outbox } from '../../src/web/outbox.ts';
import { CloseCode } from '../../src/protocol/messages.ts';

const LOADED: LinkFacts = { loaded: true, wasReady: true, bannerShown: false, droppedWith: undefined, closedBy: undefined, byeReason: '' };

test('ready hides the banner; before the first load every other state follows the loading rule', () => {
  assert.deepEqual(linkStep('ready', LOADED), { disconnect: false, t: 'hide-banner' });
  const first = { ...LOADED, loaded: false, wasReady: false };
  for (const state of ['connecting', 'reconnecting', 'offline'] as const) assert.equal(linkStep(state, first).t, 'loading', state);
});

test('a drop marks the open agent feeds for reopening, once, and never on a final close', () => {
  assert.equal(linkStep('reconnecting', LOADED).disconnect, true);
  assert.equal(linkStep('offline', { ...LOADED, wasReady: false }).disconnect, false, 'already counted at the first drop');
  assert.equal(linkStep('closed', LOADED).disconnect, false);
});

test('reconnecting waits before saying so, unless a line already shows or the server restarts', () => {
  assert.deepEqual(linkStep('reconnecting', LOADED), { disconnect: true, t: 'banner', text: 'Reconnecting…', retry: true, delayMs: RECONNECT_BANNER_MS });
  const shown = linkStep('reconnecting', { ...LOADED, bannerShown: true });
  assert.ok(shown.t === 'banner' && shown.delayMs === 0);
  assert.deepEqual(linkStep('reconnecting', { ...LOADED, droppedWith: CloseCode.restart }),
    { disconnect: true, t: 'banner', text: RESTARTING, retry: true, delayMs: 0 });
  const offline = linkStep('offline', LOADED);
  assert.ok(offline.t === 'banner' && offline.delayMs === 0 && /Tailscale/.test(offline.text));
});

test('a final close pairs again, says the app is gone, or reloads for a new protocol', () => {
  const closed = (closedBy: LinkFacts['closedBy'], byeReason = '') => linkStep('closed', { ...LOADED, closedBy, byeReason });
  assert.deepEqual(closed('unauthorized', 'Revoked by the owner.'), { disconnect: false, t: 'pair', reason: 'Revoked by the owner. Pair it again with a new code.' });
  assert.deepEqual(closed('unauthorized'), { disconnect: false, t: 'pair', reason: 'This device is no longer paired. Pair it again with a new code.' });
  assert.deepEqual(closed('unpaired'), { disconnect: false, t: 'pair', reason: '' });
  assert.equal(closed('forbidden').t, 'gone');
  assert.equal(closed('version').t, 'reload-version');
  assert.equal(closed('stopped').t, 'none');
  assert.equal(linkStep('connecting', LOADED).t, 'none', 'a loaded page shows nothing while it connects');
});

test('the outbox holds sends by id until settled, and keeps their text over a reload', () => {
  const outbox = new Outbox('web-test');
  const image = { mimeType: 'image/png', data: 'AAAA' };
  const first = outbox.add({ text: 'one', steer: false, images: [image] });
  const second = outbox.add({ text: 'two', steer: true, images: [] });
  assert.deepEqual([first, second], ['web-test-1', 'web-test-2']);
  assert.deepEqual(outbox.entries().map(([id, send]) => [id, send.text]), [[first, 'one'], [second, 'two']]);
  assert.deepEqual(outbox.beforeReload('draft', 2), { draft: 'one\n\ntwo\n\ndraft', lostImages: 3 });
  outbox.delete(first);
  assert.equal(outbox.size, 1);
  assert.deepEqual(outbox.beforeReload('', 0), { draft: 'two', lostImages: 0 });
});
