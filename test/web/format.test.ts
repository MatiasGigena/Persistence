import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionStatus } from '../../src/protocol/session.ts';
import { base64UrlBytes, guessDeviceName, formatCodeInput, pairErrorText, sortModels, statusParts } from '../../src/web/format.ts';
import { footerText } from '../../src/ui/tui/footer.ts';
import { theme } from '../../src/ui/tui/theme.ts';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

const STATUS: SessionStatus = {
  model: 'claude-cli/sonnet', thinkingLevel: 'high', toolsEnabled: false, busy: true, queued: 2,
  memory: { messages: 142, unsummarized: 2, active: 1, failed: 1, lastError: 'timeout', viewBytes: 37 * 1024, viewLines: 12 },
  agents: [{ name: 'Scout', role: 'main', parent: 'Pi', busy: true }, { name: 'Quill', role: 'sub', parent: 'Scout', busy: false }],
};

test('statusParts is the compact header line', () => {
  assert.deepEqual(statusParts(STATUS).map(p => p.text), ['working', '2 queued', 'mem 37 KB', '1 failed', '1/2 agents']);
  assert.deepEqual(statusParts({ ...STATUS, busy: false, memory: undefined, agents: [] }).map(p => p.text), ['idle']);
  assert.equal(statusParts(STATUS).find(p => p.key === 'failed')?.tone, 'error');
  const scheduled = { ...STATUS, schedules: [{ id: 1, text: 'a', at: 1 }, { id: 2, text: 'b', at: 2, cron: '0 9 * * *' }] };
  assert.deepEqual(statusParts(scheduled).at(-1), { key: 'schedules', text: '2 scheduled', tone: 'dim' });
  assert.equal(statusParts({ ...STATUS, schedules: [] }).some(p => p.key === 'schedules'), false);
});

test('archived agents are left out of the header line and the terminal footer', () => {
  const archived = { ...STATUS, agents: [...STATUS.agents, { name: 'Old', role: 'main' as const, parent: 'Pi', busy: true, archivedAt: 1 }] };
  assert.equal(statusParts(archived).find(p => p.key === 'agents')?.text, '1/2 agents');
  assert.match(stripTerminalSequences(footerText(archived, theme)), / · 1\/2 agents busy$/);
  const gone = { ...STATUS, busy: false, agents: [{ name: 'Old', role: 'main' as const, parent: 'Pi', busy: false, archivedAt: 1 }] };
  assert.deepEqual(statusParts(gone).map(p => p.key), ['work', 'memory', 'failed']);
  assert.doesNotMatch(stripTerminalSequences(footerText(gone, theme)), /agents/);
});

test('models sort current first, then available, then unavailable', () => {
  const sorted = sortModels([
    { provider: 'a', id: 'x', name: 'X', available: false, note: 'needs KEY' },
    { provider: 'b', id: 'y', name: 'Y', available: true },
    { provider: 'c', id: 'z', name: 'Z', available: true },
  ], 'c/z');
  assert.deepEqual(sorted.map(m => m.id), ['z', 'y', 'x']);
});

test('pairing codes normalize to Crockford XXXX-XXXX', () => {
  assert.equal(formatCodeInput('abcd efgh'), 'ABCD-EFGH');
  assert.equal(formatCodeInput('o1il-0000-extra'), '0111-0000');
  assert.equal(formatCodeInput('ab'), 'AB');
  assert.equal(formatCodeInput('uuuu'), '', 'U is not Crockford');
});

test('a refused pairing says which check refused it, rather than to try again', () => {
  assert.match(pairErrorText(403, 'origin'), /PI_DURABLE_ORIGIN/);
  assert.match(pairErrorText(403, 'login'), /PI_DURABLE_ALLOW_LOGIN/);
  assert.match(pairErrorText(401, 'wrong'), /wrong or has expired/);
  assert.equal(pairErrorText(500, undefined), 'The server answered 500. Try again.');
});

test('base64url VAPID keys decode to bytes', () => {
  assert.deepEqual([...base64UrlBytes('AQID_-8')], [1, 2, 3, 255, 239]);
  assert.equal(base64UrlBytes(Buffer.alloc(65, 7).toString('base64url')).length, 65);
});

test('device names come from the user agent', () => {
  assert.equal(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
  assert.equal(guessDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari'), 'Android phone');
  assert.equal(guessDeviceName('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux PC');
});
