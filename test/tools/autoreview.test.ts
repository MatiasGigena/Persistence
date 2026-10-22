import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { JsonObject } from '@earendil-works/pi-durable';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { DEFAULT_ROSTER } from '../../src/agents/roster.ts';
import { settleAgents } from '../../src/runtime/recovery.ts';
import { openInstance } from '../../src/runtime/runtime.ts';
import { createAutoreviewExtension } from '../../src/tools/autoreview.ts';
import { call, router, say, type Turn } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

/** A fake Python launcher records argv; no real reviewer, Python installation or credentials are needed. */
async function review(t: TestContext, args: JsonObject, options: { exitCode?: number; missing?: boolean; codex?: string; hiddenSkill?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-autoreview-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent with spaces');
  const skill = join(agentDir, 'skills', 'autoreview');
  const bin = join(cwd, 'bin');
  const recorded = join(cwd, 'invocation.json');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await mkdir(bin);
  if (!options.missing) {
    await writeFile(join(skill, 'SKILL.md'), 'Test skill');
    await writeFile(join(skill, 'scripts', 'autoreview'), 'Test helper');
  }
  await writeFile(join(bin, 'python3'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const invocation = { argv: process.argv.slice(2), cwd: process.cwd() };
writeFileSync(process.env.RECORDED, JSON.stringify(invocation));
console.log(JSON.stringify(invocation));
process.exit(Number(process.env.REVIEW_EXIT));
`, { mode: 0o700 });
  const extension = createAutoreviewExtension(createBashTool({ prepare(execution) {
    execution.inheritEnv = false;
    execution.env = { HOME: cwd, PATH: `${bin}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: agentDir,
      RECORDED: recorded, REVIEW_EXIT: String(options.exitCode ?? 0), ...options.codex ? { CODEX_BIN: options.codex } : {} };
  } }));
  const seen: Turn[] = [];
  const catalog = offlineModels(router({
    Pi: ({ user, last }) => user.includes('[Reviewer]') || last ? say('acknowledged')
      : call(['delegate', { agent: 'Reviewer', task: 'Review the candidate.' }]),
    Reviewer: ({ last }) => last ? say('Review returned.') : call(['autoreview', args]),
  }, seen));
  const instance = await openInstance({ cwd, databasePath: join(cwd, 'chat.sqlite'), ...catalog, allowTools: true,
    protection: { hidden: options.hiddenSkill ? [agentDir] : [], readOnly: [] }, roster: { Reviewer: { ...DEFAULT_ROSTER.Reviewer!, model: catalog.model } },
    kits: { autoreview: { extension, tools: extension.tools } }, rosterChecks: false });
  try {
    await (await instance.submit('Review.')).wait(instance.context);
    await settleAgents(instance, { intervalMs: 5 });
    const result = seen.find(turn => turn.who === 'Reviewer' && turn.last)?.last;
    assert.ok(result);
    const invocation: unknown = await readFile(recorded, 'utf8').then(text => JSON.parse(text) as unknown, () => undefined);
    return { result, invocation, cwd, skill, system: JSON.stringify(seen.find(turn => turn.who === 'Reviewer')?.request.messages) };
  } finally { await instance.close(); }
}

test('autoreview declares the guarded shell result schema instead of triggering a runtime warning', () => {
  const bash = createBashTool();
  const tool = createAutoreviewExtension(bash).tools[0];
  assert.ok(bash.structuredOutputSchema);
  assert.deepEqual(tool?.structuredOutputSchema, bash.structuredOutputSchema);
  assert.equal(tool?.replay, 'unsafe');
});

test('autoreview uses the installed helper, standalone Codex and fixed P2; its policy is in the reviewer prompt', async t => {
  const run = await review(t, { mode: 'local', base: 'abc123', prompt: 'Review correctness.', promptFiles: ['notes.md'], datasets: ['source.ts'] });
  assert.equal(run.result.isError, false, run.result.text);
  assert.deepEqual(run.invocation, { cwd: run.cwd, argv: [join(run.skill, 'scripts', 'autoreview'),
    `--codex-bin=${run.cwd}/.local/share/autoreview/codex-cli/bin/codex`, '--mode=local', '--engine=codex', '--max-priority=P2',
    '--base=abc123', '--prompt=Review correctness.', '--prompt-file=notes.md', '--dataset=source.ts'] });
  assert.match(run.system, /For every code review, read the installed \/autoreview skill/);
  assert.match(run.system, /Always review P0–P2/);
  assert.match(run.system, /Do not substitute a manual review or claim clean/);
});

test('autoreview keeps context literal and ignores a stale inherited CODEX_BIN', async t => {
  const prompt = "--max-priority=P0 '; touch injected; $(touch injected)\n`touch injected`";
  const run = await review(t, { mode: 'branch', repository: '.', base: "main'; touch injected; '", prompt,
    promptFiles: ['--engine=claude'], datasets: ["source'$(touch injected).ts"] }, { codex: '/external/codex with spaces' });
  assert.equal(run.result.isError, false, run.result.text);
  assert.deepEqual(run.invocation, { cwd: run.cwd, argv: [join(run.skill, 'scripts', 'autoreview'),
    `--codex-bin=${run.cwd}/.local/share/autoreview/codex-cli/bin/codex`, '--mode=branch', '--engine=codex', '--max-priority=P2',
    "--base=main'; touch injected; '", `--prompt=${prompt}`, '--prompt-file=--engine=claude', "--dataset=source'$(touch injected).ts"] });
  await assert.rejects(readFile(join(run.cwd, 'injected')), { code: 'ENOENT' });
});

test('commit mode and the explicit Pi availability fallback still enforce P2', async t => {
  const run = await review(t, { mode: 'commit', commit: 'HEAD~1', engine: 'pi' });
  assert.equal(run.result.isError, false, run.result.text);
  assert.deepEqual(run.invocation, { cwd: run.cwd, argv: [join(run.skill, 'scripts', 'autoreview'),
    `--codex-bin=${run.cwd}/.local/share/autoreview/codex-cli/bin/codex`, '--mode=commit', '--engine=pi', '--max-priority=P2', '--commit=HEAD~1'] });
});

test('findings and incomplete exit codes are preserved, never converted to clean or automatically retried', async t => {
  for (const exitCode of [1, 2]) {
    const run = await review(t, { mode: 'local' }, { exitCode });
    assert.equal(run.result.isError, true);
    assert.match(run.result.text, new RegExp(`Command exited with code ${exitCode}`));
    assert.ok(run.invocation, 'only the requested engine was invoked');
  }
});

test('a missing skill is incomplete, with no reviewer invocation', async t => {
  const run = await review(t, { mode: 'local' }, { missing: true });
  assert.equal(run.result.isError, true);
  assert.match(run.result.text, /skill is not installed or readable/);
  assert.match(run.result.text, /Review incomplete/);
  assert.equal(run.invocation, undefined);
});

test('the dedicated tool cannot bypass a protected skill directory', async t => {
  const run = await review(t, { mode: 'local' }, { hiddenSkill: true });
  assert.equal(run.result.isError, true);
  assert.match(run.result.text, /skill is not installed or readable/);
  assert.equal(run.invocation, undefined);
});

test('repository arguments cannot inject shell commands', async t => {
  const run = await review(t, { mode: 'local', repository: ".'; touch injected; '" });
  assert.equal(run.result.isError, true);
  assert.equal(run.invocation, undefined);
  await assert.rejects(readFile(join(run.cwd, 'injected')), { code: 'ENOENT' });
});

test('invalid scope combinations and extra flags cannot reach the helper', async t => {
  const invalid: JsonObject[] = [
    { mode: 'branch' }, { mode: 'commit', base: 'main' }, { mode: 'local', commit: 'HEAD' },
    { mode: 'auto' }, { mode: 'local', engine: 'claude' }, { mode: 'local', maxPriority: 'P0' },
    { mode: 'local', prompt: 'bad\0text' },
  ];
  for (const args of invalid) {
    const run = await review(t, args);
    assert.equal(run.result.isError, true, JSON.stringify(args));
    assert.equal(run.invocation, undefined, JSON.stringify(args));
  }
});
