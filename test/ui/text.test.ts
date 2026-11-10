import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeAgents, adhocAgents, archiveAdhocQuestion, archivedAgents, archivedText, archiveQuestion, deletionText, parseMessage,
  parseZoom, schedulesText, scheduleWhen, statusText, tokenCount, toolCommand, toolSummary, usageText, whenText,
} from '../../src/ui/text.ts';
import type { SessionStatus, UsageReport } from '../../src/protocol/session.ts';

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

test('times read against now, in the client\'s zone: today, tomorrow, then the date, with the year when it differs', () => {
  const at = (year: number, month: number, day: number, hour: number, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
  const now = at(2026, 11, 10, 14);
  assert.equal(whenText(at(2026, 11, 10, 14, 30), now), 'today 14:30');
  assert.equal(whenText(at(2026, 11, 10, 9, 5), now), 'today 09:05', 'earlier today too');
  assert.equal(whenText(at(2026, 11, 11, 0), now), 'tomorrow 00:00');
  assert.equal(whenText(at(2026, 11, 12, 9), now), 'Thu 12 Nov 09:00');
  assert.equal(whenText(at(2027, 1, 4, 9), now), 'Mon 4 Jan 2027 09:00');
  assert.equal(whenText(at(2026, 11, 9, 23, 59), now), 'Mon 9 Nov 23:59', 'yesterday is a date');
  assert.equal(scheduleWhen({ at: at(2026, 11, 11, 9) }, now), 'tomorrow 09:00');
  assert.equal(scheduleWhen({ at: at(2026, 11, 11, 9), cron: '0 9 * * 1-5' }, now), 'cron 0 9 * * 1-5 · next tomorrow 09:00');
});

test('/schedule lists the wake-ups and how to cancel one; /status counts them and names the next', () => {
  const at = (day: number, hour: number): number => new Date(2026, 10, day, hour).getTime();
  const now = at(10, 14);
  const schedules = [{ id: 3, text: 'Check the deploy.', at: at(10, 15) }, { id: 4, text: 'Morning summary.', at: at(11, 9), cron: '0 9 * * *' }];
  assert.equal(schedulesText(schedules, now), [
    '#3 · today 15:00 · Check the deploy.', '#4 · cron 0 9 * * * · next tomorrow 09:00 · Morning summary.',
    '/schedule cancel N cancels one; ask Pi for a new one.',
  ].join('\n'));
  assert.equal(schedulesText([], now), 'No schedules. Ask Pi to remind you of something, or to check back on it later.');
  assert.match(statusText({ ...STATUS, schedules }, now), /\nschedules 2 · next #3 today 15:00$/);
  assert.doesNotMatch(statusText({ ...STATUS, schedules: [] }, now), /schedules/);
  assert.doesNotMatch(statusText(STATUS, now), /schedules/, 'a server without schedules in its status');
});

test('token counts are compact: three digits at most, and a unit', () => {
  const cases: [number, string][] = [
    [0, '0'], [999, '999'], [1000, '1k'], [1234, '1.2k'], [61_000, '61k'], [80_449, '80.4k'], [99_960, '100k'], [210_499, '210k'],
    [999_499, '999k'], [999_500, '1M'], [1_240_000, '1.2M'], [3_400_000_000, '3.4B'], [2_000_000_000_000, '2T'], [5e15, '5000T'],
  ];
  for (const [count, text] of cases) assert.equal(tokenCount(count), text, String(count));
});

test('usageText: each period\'s sum, then its models aligned, and since when days are counted', () => {
  const now = new Date(2026, 10, 10, 15).getTime();
  const opus = { model: 'claude-cli/opus', input: 900_000, output: 61_000, cacheRead: 3_000_000, cacheWrite: 210_000, cost: 3.8 };
  const sol = { model: 'openai-codex/gpt-6.1-sol', input: 300_000, output: 19_400, cacheRead: 400_000, cacheWrite: 0, cost: 0.41 };
  const luna = { model: 'openai-codex/gpt-6-luna', input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0004 };
  // claude-cli reports no cost, so none is shown.
  const haiku = { model: 'claude-cli/haiku', input: 999, output: 7, cacheRead: 0, cacheWrite: 1000, cost: 0 };
  const report: UsageReport = { today: [opus, sol], week: [opus, sol, luna, haiku], all: [], since: new Date(2026, 10, 10, 14, 3).getTime() };
  assert.equal(usageText(report, now), [
    'today    in 1.2M · out 80.4k · cache 3.4M read, 210k written · $4.21',
    '  claude-cli/opus           in 900k · out 61k · cache 3M read, 210k written · $3.80',
    '  openai-codex/gpt-6.1-sol  in 300k · out 19.4k · cache 400k read · $0.41',
    '7 days   in 1.2M · out 80.5k · cache 3.4M read, 211k written · $4.21',
    '  claude-cli/opus           in 900k · out 61k · cache 3M read, 210k written · $3.80',
    '  openai-codex/gpt-6.1-sol  in 300k · out 19.4k · cache 400k read · $0.41',
    '  openai-codex/gpt-6-luna   in 1.2k · out 80 · <$0.01',
    '  claude-cli/haiku          in 999 · out 7 · cache 1k written',
    'all time nothing yet',
    'Costs are catalog prices; on a subscription plan they are not what you pay. Daily counting began today 14:03.',
  ].join('\n'));
  assert.equal(usageText({ today: [], week: [], all: [] }, now), [
    'today    nothing yet', '7 days   nothing yet', 'all time nothing yet',
    'Costs are catalog prices; on a subscription plan they are not what you pay.',
  ].join('\n'), 'no since before the first sample');
  assert.match(usageText({ ...report, since: new Date(2026, 10, 5, 9).getTime() }, now), /Daily counting began Thu 5 Nov 09:00\.$/);
});
