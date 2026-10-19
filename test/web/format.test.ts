import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionStatus } from '../../src/protocol/messages.ts';
import {
  base64UrlBytes, guessDeviceName, normalizeCode, parseMessage, parseZoom, sortModels, statusParts, statusText, toolSummary,
} from '../../src/web/format.ts';
import { parseMessage as tuiParseMessage, parseZoom as tuiParseZoom } from '../../src/ui/tui/panels/memory.ts';
import { toolSummary as tuiToolSummary } from '../../src/ui/tui/chat.ts';
import { statusText as tuiStatusText } from '../../src/ui/tui/app.ts';

const STATUS: SessionStatus = {
  model: 'claude-cli/sonnet', thinkingLevel: 'high', toolsEnabled: false, busy: true, queued: 2,
  memory: { messages: 142, unsummarized: 2, active: 1, failed: 1, lastError: 'timeout', viewBytes: 37 * 1024, viewLines: 12 },
  agents: [{ name: 'Scout', role: 'main', parent: 'Pi', busy: true }, { name: 'Quill', role: 'sub', parent: 'Scout', busy: false }],
};

test('toolSummary matches the terminal on every kind of call', () => {
  const cases: [string, string][] = [
    ['bash', '{"command":"ls -la\\n  src","timeout":5}'], ['read', '{"path":"src/a.ts","offset":3}'],
    ['write', '{"path":"b.md","content":"long text"}'], ['edit', '{"path":"c.ts","edits":[]}'],
    ['zoom', '{"id":12,"n":4}'], ['zoom', '{"id":7}'], ['zoom', '{"id":"Scout"}'],
    ['spawn_agent', '{"name":"Scout","task":"find it"}'], ['send_message', '{"to":"Pi","text":"done"}'],
    ['bash', '{"command":"echo \\"hi'], ['list_agents', '{}'], ['date', '{"id":3}'],
    ['mystery', JSON.stringify({ text: 'x'.repeat(200) })], ['bash', '{"command":"a\\tb\\u001b[31mred"}'],
  ];
  for (const [name, args] of cases) assert.equal(toolSummary(name, args), tuiToolSummary(name, args), `${name} ${args}`);
});

test('the full status and the memory parsers match the terminal', () => {
  assert.equal(statusText(STATUS), tuiStatusText(STATUS));
  assert.equal(statusText({ ...STATUS, memory: undefined, agents: [] }), tuiStatusText({ ...STATUS, memory: undefined, agents: [] }));
  const zoom = '3+2|first half\n5+2|second half\nnot a line';
  assert.deepEqual(parseZoom(zoom), tuiParseZoom(zoom));
  for (const out of ['4+1|user: hi', '4+1 (page 1 of 3)|pi: long', 'no bar']) assert.deepEqual(parseMessage(out), tuiParseMessage(out));
});

test('statusParts is the compact header line', () => {
  assert.deepEqual(statusParts(STATUS).map(p => p.text), ['working', '2 queued', 'mem 37 KB', '1 failed', '1/2 agents']);
  assert.deepEqual(statusParts({ ...STATUS, busy: false, memory: undefined, agents: [] }).map(p => p.text), ['idle']);
  assert.equal(statusParts(STATUS).find(p => p.key === 'failed')?.tone, 'error');
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
  assert.equal(normalizeCode('abcd efgh'), 'ABCD-EFGH');
  assert.equal(normalizeCode('o1il-0000-extra'), '0111-0000');
  assert.equal(normalizeCode('ab'), 'AB');
  assert.equal(normalizeCode('uuuu'), '', 'U is not Crockford');
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
