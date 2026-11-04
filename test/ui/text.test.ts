import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeAgents, adhocAgents, archiveAdhocQuestion, archivedAgents, archivedText, archiveQuestion, deletionText, parseMessage,
  parseZoom, statusText, toolCommand, toolSummary,
} from '../../src/ui/text.ts';
import type { SessionStatus } from '../../src/ui/types.ts';

const STATUS: SessionStatus = {
  model: 'claude-cli/sonnet', thinkingLevel: 'high', toolsEnabled: false, busy: true, queued: 2,
  memory: { messages: 142, unsummarized: 2, active: 1, failed: 1, lastError: 'timeout', viewBytes: 37 * 1024, viewLines: 12 },
  agents: [{ name: 'Scout', role: 'main', parent: 'Pi', busy: true }, { name: 'Quill', role: 'sub', parent: 'Scout', busy: false }],
};

test('toolSummary picks the one meaningful argument of each kind of call, on one line', () => {
  const cases: [string, string, string][] = [
    ['bash', '{"command":"ls -la\\n  src","timeout":5}', 'ls -la src'], ['read', '{"path":"src/a.ts","offset":3}', 'src/a.ts'],
    ['write', '{"path":"b.md","content":"long text"}', 'b.md'], ['edit', '{"path":"c.ts","edits":[]}', 'c.ts'],
    ['zoom', '{"id":12,"n":4}', '12+4'], ['zoom', '{"id":7}', '7+1'], ['zoom', '{"id":"Scout"}', 'Scout'],
    ['spawn_agent', '{"name":"Scout","task":"find it"}', 'Scout'], ['send_message', '{"to":"Pi","text":"done"}', 'Pi'],
    ['bash', '{"command":"echo \\"hi', 'echo "hi'], ['list_agents', '{}', ''], ['date', '{"id":3}', '{"id":3}'],
    ['bash', '{"command":"a\\tb\\u001b[31mred"}', 'a bred'],
  ];
  for (const [name, args, summary] of cases) assert.equal(toolSummary(name, args), summary, `${name} ${args}`);
  const long = toolSummary('mystery', JSON.stringify({ text: 'x'.repeat(200) }));
  assert.equal([...long].length, 60);
  assert.ok(long.startsWith('{"text":"xxx') && long.endsWith('…'));
});

test('toolCommand is a bash call\'s command with its lines, even while its arguments stream in', () => {
  assert.equal(toolCommand('bash', '{"command":"cd src &&\\n  ls -la"}'), 'cd src &&\n  ls -la');
  assert.equal(toolCommand('bash', '{"command":"git sta'), 'git sta');
  assert.equal(toolCommand('read', '{"path":"a.ts"}'), undefined);
});

test('statusText is the full /status block, the tool machine included', () => {
  assert.equal(statusText(STATUS), [
    'model claude-cli/sonnet · thinking high · tools off', 'work running · 2 queued',
    'memory 142 msgs · 2 unsummarized · view 12 lines, 37888 bytes · 1 summarizing · 1 failed', 'memory error: timeout',
    'agents Scout (main, busy), Quill (sub, idle)',
  ].join('\n'));
  const machine = { machineId: 'm1', label: 'laptop', cwd: '/home/me/app' };
  assert.equal(statusText({ ...STATUS, memory: undefined, agents: [], machine }), [
    'model claude-cli/sonnet · thinking high · tools off', 'tools run on laptop in /home/me/app', 'work running · 2 queued',
    'memory closed', 'agents none',
  ].join('\n'));
});

test('zoom output parses into view lines and a message with its page note', () => {
  assert.deepEqual(parseZoom('3+2|first half\n5+2|second half\nnot a line'),
    [{ id: 3, n: 2, text: 'first half' }, { id: 5, n: 2, text: 'second half' }]);
  assert.deepEqual(parseMessage('4+1|user: hi'), { note: undefined, body: 'user: hi' });
  assert.deepEqual(parseMessage('4+1 (page 1 of 3)|pi: long'), { note: '(page 1 of 3)', body: 'pi: long' });
  assert.deepEqual(parseMessage('no bar'), { note: undefined, body: 'no bar' });
});

test('archived agents are left out of counts and lists', () => {
  const agents = [...STATUS.agents, { name: 'Old', role: 'main' as const, parent: 'Pi', busy: true, archivedAt: 1 }];
  assert.match(statusText({ ...STATUS, agents }), /agents Scout \(main, busy\), Quill \(sub, idle\)\narchived 1$/);
  assert.deepEqual(activeAgents(agents).map(a => a.name), ['Scout', 'Quill']);
  assert.deepEqual(archivedAgents(agents).map(a => a.name), ['Old']);
  assert.deepEqual(adhocAgents(agents).map(a => a.name), ['Scout']);
  const standing = { name: 'Scribe', role: 'main' as const, parent: 'Pi', busy: false, standing: true as const };
  assert.deepEqual(adhocAgents([standing]), []);
});

test('deletion times and archive wording', () => {
  const at = Date.UTC(2026, 9, 21), hour = 3_600_000;
  const cases: [number, string][] = [
    [0, 'deleted in 24 h'], [18.5 * hour, 'deleted in 5 h'], [23 * hour, 'deleted in 1 h'], [23.25 * hour, 'deleted in 45 min'],
    [24 * hour - 1, 'deleted in 1 min'], [24 * hour, 'deleted soon'], [30 * hour, 'deleted soon'],
  ];
  for (const [since, text] of cases) assert.equal(deletionText(at, at + since), text, `${since}`);
  assert.equal(archiveQuestion('Helper'), 'Archive Helper? It stops now and is deleted in 24 h; restore within the day.');
  assert.match(archiveQuestion('Helper', ['A', 'B']), / Its sub agents go with it: A, B\.$/);
  assert.equal(archiveAdhocQuestion(['A', 'B']),
    'Archive all ad-hoc agents: A, B? They and their sub agents stop now and are deleted in 24 h; restore within the day. Standing agents stay.');
  assert.equal(archivedText([]), 'No agents to archive.');
  assert.equal(archivedText([], true), 'Nothing to restore.');
  assert.equal(archivedText(['A', 'B']), 'Archived A, B.');
  assert.equal(archivedText(['A'], true), 'Restored A.');
});
