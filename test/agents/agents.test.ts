import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { AgentsDoc, agentTranscript, createAgentsExtension, listAgents } from '../../src/agents/index.ts';
import { call, openAgents, router, say } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

async function temporary(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-agents-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'agents.sqlite') };
}

/** Test-only: wait until no task or submission is live anywhere. */
async function settle({ harness, context }, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}

async function entries(harness, conversationId, context) {
  const all = [];
  let cursor;
  do {
    const page = await harness.commit((tx) => tx.scanEntries({ conversationId, order: 'ascending' }, 256, cursor), context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}

const agentId = async ({ harness, context }, name) => (await harness.snapshot(AgentsDoc, context)).agents[name].conversationId;
const ofKind = (list, kind) => list.filter((entry) => entry.kind === kind);
const userTexts = (list) => list.flatMap((entry) => (entry.model ?? []).filter((message) => message.role === 'user'))
  .map((message) => typeof message.content === 'string' ? message.content : message.content.map((block) => block.text).join(''));
const results = (list) => ofKind(list, 'pi.tool-result').map((entry) => entry.model[0]);

describe('multi-agent messaging (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('Pi → main → two subs: list, message, last_message, reports, and role limits', async (t) => {
    const options = await temporary(t);
    const reports = [];
    const seen = [];
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user === 'Start Lead.' && !last) return call(['spawn_agent', { name: 'Lead', task: 'Plan the work.' }]);
        if (last?.name === 'spawn_agent') return say('Lead started.');
        if (user.startsWith('[Lead]')) return say('Noted.');
      },
      Lead: ({ user, last, results: done }) => {
        if (user.includes('Plan the work.')) {
          if (!last) return call(['spawn_agent', { name: 'B', task: 'Do part B.' }]);
          if (done.length === 1) return call(['spawn_agent', { name: 'A', task: 'Do part A.' }]);
          return say('Delegated to A and B.');
        }
        if (user.startsWith('[A]')) {
          if (!last) return call(['last_message', { name: 'B' }], ['last_message', { name: 'Pi' }]);
          if (last.name === 'last_message') return call(['send_message', { to: 'Pi', text: 'A finished.' }]);
          return say('Lead saw A.');
        }
        // Unique per report, so a duplicate delivery would show as a repeated text.
        if (user.startsWith('[B]')) return say(`Lead saw ${user}`);
      },
      A: ({ user, last, results: done }) => {
        if (!user.includes('Do part A.')) return undefined;
        if (!last) return call(['list_agents', {}]);
        if (last.name === 'list_agents') {
          return call(['send_message', { to: 'Pi', text: 'hi Pi' }], ['spawn_agent', { name: 'C', task: 'x' }],
            ['last_message', { name: 'Pi' }]);
        }
        if (done.length === 4) return call(['send_message', { to: 'B', text: 'hello from A' }]);
        return say('A done.');
      },
      B: ({ user }) => user.includes('hello from A') ? say('B got hello.') : say('B done.'),
    }, seen));
    const instance = await openAgents({ ...options, ...catalog,
      hooks: { onReport: (report) => reports.push(report),
        initialContext: ({ name, role, parent }) => `<view>context for ${name} (${role} of ${parent})</view>` } });
    try {
      const { harness, root, context } = instance;
      const submission = await root.submit({ type: 'input', content: 'Start Lead.' }, context);
      assert.equal((await submission.wait(context)).status, 'done');
      await settle(instance);

      // Registry and per-role tool offers.
      const agents = Object.fromEntries((await listAgents(harness, context)).map((agent) => [agent.name, agent]));
      assert.deepEqual(Object.keys(agents).sort(), ['A', 'B', 'Lead']);
      assert.deepEqual([agents.Lead.role, agents.Lead.parent], ['main', 'Pi']);
      assert.deepEqual([agents.A.role, agents.A.parent, agents.B.role, agents.B.parent], ['sub', 'Lead', 'sub', 'Lead']);
      const offered = async (name) => (await (await harness.conversation(agents[name].conversationId, context))
        .agent(context)).tools.map((tool) => tool.name).sort();
      assert.deepEqual(await offered('Lead'), ['last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent']);
      assert.deepEqual(await offered('A'), ['last_message', 'list_agents', 'send_message']);
      assert.equal((await root.agent(context)).model.modelId, (await (await harness.conversation(agents.A.conversationId, context)).agent(context)).model.modelId);

      // First inputs: preamble from initialContext, then the task from the spawner.
      const lead = await entries(harness, agents.Lead.conversationId, context);
      assert.equal(userTexts(ofKind(lead, 'agents.message'))[0], '<view>context for Lead (main of Pi)</view>\n\n[from Pi] Plan the work.');
      const a = await entries(harness, agents.A.conversationId, context);
      assert.deepEqual(ofKind(a, 'agents.message').map((entry) => entry.data), [{ from: 'Lead', text: 'Do part A.' }]);

      // A sub lists all other agents, but not Pi.
      const byCall = Object.fromEntries(ofKind(a, 'pi.assistant').flatMap((entry) => entry.model[0].content)
        .filter((block) => block.type === 'toolCall').map((block) => [`${block.name}:${JSON.stringify(block.arguments)}`, block.id]));
      const resultOf = (name, args) => results(a).find((result) => result.toolCallId === byCall[`${name}:${JSON.stringify(args)}`]);
      const list = resultOf('list_agents', {});
      const toPi = resultOf('send_message', { to: 'Pi', text: 'hi Pi' });
      const spawn = resultOf('spawn_agent', { name: 'C', task: 'x' });
      const lastPi = resultOf('last_message', { name: 'Pi' });
      const toB = resultOf('send_message', { to: 'B', text: 'hello from A' });
      assert.match(list.content[0].text, /- Lead \(main, parent Pi\) (busy|idle)/);
      assert.match(list.content[0].text, /- B \(sub, parent Lead\) (busy|idle)/);
      assert.doesNotMatch(list.content[0].text, /Pi \(session/);
      // A sub can neither address Pi nor spawn.
      assert.equal(toPi.isError, true);
      assert.match(JSON.stringify(toPi.content), /cannot address Pi/);
      assert.equal(spawn.isError, true);
      assert.equal(lastPi.isError, true);
      assert.match(JSON.stringify(lastPi.content), /cannot address Pi/);
      assert.equal(toB.content[0].text, 'Sent to B.');

      // The sub-to-sub message reached B and started (or steered) a run that answered it.
      const b = await entries(harness, agents.B.conversationId, context);
      assert.deepEqual(ofKind(b, 'agents.message').map((entry) => entry.data.from), ['Lead', 'A']);
      assert.ok(userTexts(b).includes('[from A] hello from A'));
      assert.ok(seen.some((turn) => turn.who === 'B' && turn.user === '[from A] hello from A'));

      // Sub reports reached Lead; last_message works for a sub and for Pi.
      const reportsToLead = ofKind(await entries(harness, agents.Lead.conversationId, context), 'agents.report');
      assert.ok(reportsToLead.some((entry) => entry.data.name === 'A' && entry.data.text === 'A done.'));
      assert.ok(reportsToLead.some((entry) => entry.data.name === 'B'));
      const leadResults = results(await entries(harness, agents.Lead.conversationId, context));
      const lastB = leadResults.find((result) => result.toolName === 'last_message' && /^B is/.test(result.content[0].text));
      assert.match(lastB.content[0].text, /^B is (busy|idle)\. Last message:\nB (done|got hello)\./);
      assert.match(leadResults.find((result) => /^Pi is/.test(result.content[0]?.text)).content[0].text,
        /^Pi is (busy|idle)\. Last message:\n(Lead started\.|Noted\.)/);

      // Main → Pi messages and final reports reach Pi as agents.report entries, each once.
      const rootReports = ofKind(await entries(harness, ROOT_CONVERSATION_ID, context), 'agents.report');
      const texts = rootReports.map((entry) => entry.data.text);
      assert.ok(rootReports.every((entry) => entry.data.name === 'Lead'));
      assert.equal(new Set(texts).size, texts.length, `duplicate report: ${texts}`);
      assert.ok(texts.includes('Delegated to A and B.'));
      assert.ok(texts.includes('A finished.'));
      assert.ok(userTexts(rootReports).includes('[Lead] Delegated to A and B.'));
      assert.ok(userTexts(rootReports).includes('[Lead] A finished.'));
      assert.deepEqual(reports.map((report) => report.text).sort(), [...texts].sort());
      assert.ok(reports.every((report) => report.name === 'Lead'));
      assert.ok(seen.some((turn) => turn.who === 'Pi' && turn.user === '[Lead] A finished.'));

      // Transcript rendering for zoom().
      const zoom = await agentTranscript(harness, 'B', context);
      assert.match(zoom, /> \[from A\] hello from A/);
      assert.match(zoom, /B: B got hello\./);
      assert.match(await agentTranscript(harness, 'Pi', context), /spawn_agent\(\{"name":"Lead"/);
    } finally {
      await instance.close();
    }
  });

  test('execute refuses Pi-addressing and spawning for sub agents too', async (t) => {
    const options = await temporary(t);
    const catalog = offlineModels(router({
      Pi: ({ last }) => last ? say('ok') : call(['spawn_agent', { name: 'M', task: 'spawn S' }]),
      M: ({ last }) => last ? say('done') : call(['spawn_agent', { name: 'S', task: 'idle' }]),
      S: () => say('idle'),
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await settle(instance);
      const tools = Object.fromEntries(createAgentsExtension().tools.map((tool) => [tool.name, tool]));
      const api = { taskId: 'direct', conversationId: await agentId(instance, 'S'),
        snapshot: (...args) => harness.snapshot(...args), commit: (change, ctx) => harness.commit(change, ctx) };
      let calls = 0;
      const run = async (name, args) => (await tools[name].execute(args, { ...api, taskId: `direct-${++calls}` }, context)).output[0].text;
      assert.match(await run('send_message', { to: 'Pi', text: 'x' }), /cannot address Pi/);
      assert.match(await run('send_message', { to: 'pi', text: 'x' }), /cannot address Pi/);
      assert.match(await run('last_message', { name: 'Pi' }), /cannot address Pi/);
      assert.match(await run('spawn_agent', { name: 'X', task: 'x' }), /cannot spawn/);
      assert.match(await run('stop_agent', { name: 'M' }), /cannot stop/);
      assert.match(await run('send_message', { to: 'S', text: 'x' }), /yourself/);
      const rootApi = { ...api, taskId: 'direct-root', conversationId: ROOT_CONVERSATION_ID };
      assert.match((await tools.spawn_agent.execute({ name: 'M', task: 'x' }, rootApi, context)).output[0].text, /already exists/);
      assert.match((await tools.spawn_agent.execute({ name: 'bad name', task: 'x' }, { ...rootApi, taskId: 'r2' }, context)).output[0].text, /Invalid name/);
      assert.match((await tools.spawn_agent.execute({ name: 'pi', task: 'x' }, { ...rootApi, taskId: 'r3' }, context)).output[0].text, /Invalid name/);
      assert.deepEqual(Object.keys((await harness.snapshot(AgentsDoc, context)).agents).sort(), ['M', 'S']);
    } finally {
      await instance.close();
    }
  });

  test('close and reopen mid-flight delivers each message and report exactly once', async (t) => {
    const options = await temporary(t);
    const started = Promise.withResolvers();
    const first = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user === 'go' && !last) return call(['spawn_agent', { name: 'M', task: 'work' }]);
        if (last) return say('spawned');
      },
      M: ({ last }) => last ? say('M waiting') : call(['spawn_agent', { name: 'S', task: 'slow job' }]),
      S: async ({ signal }) => { started.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); },
    }));
    let instance = await openAgents({ ...options, ...first });
    try {
      await (await instance.root.submit({ type: 'input', content: 'go' }, instance.context)).wait(instance.context);
      await started.promise;
    } finally {
      await instance.close();
    }
    const reports = [];
    const seen = [];
    const second = offlineModels(router({
      Pi: ({ user }) => user.startsWith('[M]') ? say('Pi noted') : undefined,
      M: ({ user }) => user.startsWith('[M]') ? undefined
        : user === '[S] slow job done' ? say('M relays: S finished') : say('M waiting'),
      S: () => say('slow job done'),
    }, seen));
    instance = await openAgents({ ...options, ...second, hooks: { onReport: (report) => reports.push(report) } });
    try {
      instance.harness.resume();
      await settle(instance);
      await assertExactlyOnce(instance, reports);
      assert.equal(seen.filter((turn) => turn.who === 'S').length, 1);
      assert.equal(seen.filter((turn) => turn.who === 'M' && turn.user === '[S] slow job done').length, 1);
    } finally {
      await instance.close();
    }
  });

  test('SIGKILL mid-flight, then reopen: every delivery happens exactly once', async (t) => {
    const options = await temporary(t);
    const child = fork(new URL('../fixtures/agents-pending.ts', import.meta.url), [options.databasePath, options.cwd],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const exited = once(child, 'exit');
    exited.catch(() => {});
    let instance;
    try {
      const timeout = new AbortController();
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message),
        exited.then(([code, signal]) => { throw new Error(`fixture exited ${code}/${signal}: ${stderr}`); }),
        delay(20_000, undefined, { signal: timeout.signal })
          .then(() => { throw new Error(`fixture readiness timeout: ${stderr}`); }, () => {}),
      ]).finally(() => timeout.abort());
      assert.equal(ready.type, 'pending', JSON.stringify(ready));
      assert.ok(child.kill('SIGKILL'));
      const [code, signal] = await exited;
      assert.deepEqual([code, signal], [null, 'SIGKILL']);

      const reports = [];
      const catalog = offlineModels(router({
        Pi: ({ user }) => user.startsWith('[M]') ? say('Pi noted') : undefined,
        M: ({ user }) => user === '[S] slow job done' ? say('M relays: S finished') : undefined,
        S: () => say('slow job done'),
      }));
      instance = await openAgents({ ...options, ...catalog, hooks: { onReport: (report) => reports.push(report) } });
      // The interrupted model request reran: S's input and its delivery task survived the kill.
      instance.harness.resume();
      await settle(instance);
      await assertExactlyOnce(instance, reports);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => {});
      if (instance) await instance.close();
    }
  });
});

/** Shared by the restart tests: Pi → M → S, with S's model request in flight at the crash. */
async function assertExactlyOnce(instance, reports) {
  const { harness, context } = instance;
  const s = await entries(harness, await agentId(instance, 'S'), context);
  const m = await entries(harness, await agentId(instance, 'M'), context);
  const root = await entries(harness, ROOT_CONVERSATION_ID, context);
  assert.deepEqual(userTexts(ofKind(s, 'agents.message')), ['[from M] slow job']);
  assert.deepEqual(ofKind(s, 'pi.assistant').map((entry) => entry.model[0].content.map((block) => block.text).join('')),
    ['slow job done']);
  assert.deepEqual(ofKind(m, 'agents.message').map((entry) => entry.data), [{ from: 'Pi', text: 'work' }]);
  assert.ok([...ofKind(m, 'agents.report'), ...ofKind(root, 'agents.report')].every((entry) => entry.data.id !== undefined));
  assert.deepEqual(ofKind(m, 'agents.report').map(({ data: { name, text } }) => ({ name, text })), [{ name: 'S', text: 'slow job done' }]);
  assert.deepEqual(ofKind(root, 'agents.report').map(({ data: { name, text } }) => ({ name, text })),
    [{ name: 'M', text: 'M waiting' }, { name: 'M', text: 'M relays: S finished' }]);
  assert.equal(ofKind(root, 'pi.user').length, 1);
  // onReport sees what reached Pi in this process; the first report may predate the restart.
  assert.ok(reports.some((report) => report.name === 'M' && report.text === 'M relays: S finished'));
  assert.equal(new Set(reports.map((report) => report.text)).size, reports.length);
}
