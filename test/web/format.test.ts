import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionStatus } from '../../src/protocol/messages.ts';
import {
  activeAgents, adhocAgents, archiveAdhocQuestion, archivedAgents, archivedText, archiveQuestion, deletionText,
  base64UrlBytes, guessDeviceName, normalizeCode, pairErrorText, parseMessage, parseZoom, sortModels, statusParts, statusText, toolCommand, toolSummary,
} from '../../src/web/format.ts';
import { parseMessage as tuiParseMessage, parseZoom as tuiParseZoom } from '../../src/ui/tui/panels/memory.ts';
import { toolSummary as tuiToolSummary } from '../../src/ui/tui/chat.ts';
import { statusText as tuiStatusText } from '../../src/ui/tui/app.ts';
import { footerText } from '../../src/ui/tui/footer.ts';
import * as tui from '../../src/ui/tui/panels/agents.ts';
import { theme } from '../../src/ui/tui/theme.ts';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

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

test('toolCommand is a bash call\'s command with its lines, even while its arguments stream in', () => {
  assert.equal(toolCommand('bash', '{"command":"cd src &&\\n  ls -la"}'), 'cd src &&\n  ls -la');
  assert.equal(toolCommand('bash', '{"command":"git sta'), 'git sta');
  assert.equal(toolCommand('read', '{"path":"a.ts"}'), undefined);
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

test('archived agents are left out of counts and lists, on the web and in the terminal alike', () => {
  const archived = { ...STATUS, agents: [...STATUS.agents, { name: 'Old', role: 'main' as const, parent: 'Pi', busy: true, archivedAt: 1 }] };
  assert.equal(statusText(archived), tuiStatusText(archived));
  assert.match(statusText(archived), /agents Scout \(main, busy\), Quill \(sub, idle\)\narchived 1$/);
  assert.equal(statusParts(archived).find(p => p.key === 'agents')?.text, '1/2 agents');
  assert.match(stripTerminalSequences(footerText(archived, theme)), / · 1\/2 agents busy$/);
  const gone = { ...STATUS, busy: false, agents: [{ name: 'Old', role: 'main' as const, parent: 'Pi', busy: false, archivedAt: 1 }] };
  assert.equal(statusText(gone), tuiStatusText(gone));
  assert.deepEqual(statusParts(gone).map(p => p.key), ['work', 'memory', 'failed']);
  assert.doesNotMatch(stripTerminalSequences(footerText(gone, theme)), /agents/);
  assert.deepEqual(activeAgents(archived.agents), tui.activeAgents(archived.agents));
  assert.deepEqual(archivedAgents(archived.agents), tui.archivedAgents(archived.agents));
  assert.deepEqual(adhocAgents(archived.agents).map(a => a.name), ['Scout']);
  assert.deepEqual(adhocAgents(archived.agents), tui.adhocAgents(archived.agents));
});

test('deletion times and archive wording match the terminal', () => {
  const at = Date.UTC(2026, 9, 21), hour = 3_600_000;
  const cases: [number, string][] = [
    [0, 'deleted in 24 h'], [18.5 * hour, 'deleted in 5 h'], [23 * hour, 'deleted in 1 h'], [23.25 * hour, 'deleted in 45 min'],
    [24 * hour - 1, 'deleted in 1 min'], [24 * hour, 'deleted soon'], [30 * hour, 'deleted soon'],
  ];
  for (const [since, text] of cases) {
    assert.equal(deletionText(at, at + since), text, `${since}`);
    assert.equal(tui.deletionText(at, at + since), text, `${since}`);
  }
  assert.equal(archiveQuestion('Helper'), 'Archive Helper? It stops now and is deleted in 24 h; restore within the day.');
  assert.equal(archiveQuestion('Helper', ['A', 'B']), tui.archiveQuestion('Helper', ['A', 'B']));
  assert.match(archiveQuestion('Helper', ['A', 'B']), / Its sub agents go with it: A, B\.$/);
  assert.equal(archiveAdhocQuestion(['A', 'B']), tui.archiveAdhocQuestion(['A', 'B']));
  for (const [names, restored] of [[[], false], [[], true], [['A', 'B'], false], [['A'], true]] as const) {
    assert.equal(archivedText(names, restored), tui.archivedText(names, restored));
  }
  assert.equal(archivedText(['A', 'B']), 'Archived A, B.');
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
