import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { obj, str } from '@earendil-works/pi-schema';
import { AgentDoc, defineExtension, defineTool, InboxDoc, LiveDoc, type JsonObject, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { AgentsDoc, type Roster, syncAgents } from '../../src/agents/index.ts';
import { AgentRouteDoc, RoutingDoc, RunRouteDoc, SubmissionRouteDoc, type RoutingDispatcher } from '../../src/machines/routing.ts';
import { settleAgents } from '../../src/runtime/recovery.ts';
import { TURN_HEAD } from '../../src/memory/extension.ts';
import { openInstance, transcript, type Instance } from '../../src/runtime/runtime.ts';
import type { MachineTarget } from '../../src/ui/types.ts';
import { createUiSession } from '../../src/ui/session.ts';
import { call, router, say, type Turn } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const laptop: MachineTarget = { machineId: 'laptop', cwd: '/remote/project', label: 'My laptop' };
const other: MachineTarget = { machineId: 'other', cwd: '/other/project', label: 'Other machine' };
const result = (text: string): ToolExecutionResult => ({ output: [{ type: 'text', text }] });
const currentText = (user: string) => user.includes(TURN_HEAD) ? user.slice(user.lastIndexOf(TURN_HEAD) + TURN_HEAD.length) : user;

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-routing-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'chat.sqlite') };
}

function recorder() {
  const calls: { target: MachineTarget; id: string; name: string; args: JsonObject }[] = [];
  const dispatcher: RoutingDispatcher = {
    execute(target, id, name, args) {
      calls.push({ target, id, name, args });
      return Promise.resolve(result('remote result'));
    },
  };
  return { calls, dispatcher };
}

async function submit(instance: Instance, text: string, id: string, target?: MachineTarget) {
  const submission = await instance.submit(text, id, target);
  const settled = await submission.wait(instance.context);
  assert.equal(settled.status, 'done', JSON.stringify(settled));
  return submission;
}

async function agentPins(instance: Instance) {
  const agents = await instance.harness.snapshot(AgentsDoc, instance.context);
  return Promise.all(Object.values(agents?.agents ?? {}).map(async ({ conversationId }) => ({
    conversationId, target: (await instance.harness.snapshot(AgentRouteDoc, conversationId, instance.context))?.target,
  })));
}

async function errors(instance: Instance): Promise<string> {
  const entries = await transcript(instance.root, instance.context);
  return entries.flatMap(entry => entry.model ?? [])
    .filter(message => message.role === 'toolResult' && message.isError).map(message => JSON.stringify(message)).join('\n');
}

describe('immutable machine routing (offline)', { timeout: 30_000 }, () => {
  test('remote tools dispatch immutable intent; omitted target explicitly runs on the server', async t => {
    const options = await temporary(t);
    await writeFile(join(options.cwd, 'fixture.txt'), 'host-only content');
    const recorded = recorder();
    const seen: Turn[] = [];
    const catalog = offlineModels(router({ Pi: async ({ last }) => {
      const run = (await instance.harness.snapshot(LiveDoc, instance.root.id, instance.context))?.run;
      assert.ok(run);
      const route = await instance.harness.snapshot(RunRouteDoc, run.taskId, instance.context);
      assert.ok(route?.target, 'the current generation has its own pinned route');
      return last ? say('done') : call(['read', { path: 'fixture.txt' }]);
    } }, seen));
    const instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true });
    try {
      await assert.rejects(instance.submit('fake server cwd', 'fake-host', { machineId: 'server', cwd: '/not-the-host-cwd', label: 'server' }), /destination mismatch/i);
      await submit(instance, 'remote', 'remote-1', laptop);
      assert.deepEqual(recorded.calls.map(each => each.target), [laptop]);
      assert.equal(recorded.calls[0]?.name, 'read');
      const routing = await instance.harness.snapshot(RoutingDoc, instance.context);
      assert.ok(routing);
      assert.match(recorded.calls[0]?.id ?? '', new RegExp(`^${routing.namespace}:\\d+$`));
      assert.deepEqual(Object.keys(routing), ['namespace']);
      assert.deepEqual((await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, 'request:remote-1', instance.context))?.target, laptop);
      const firstPrompt = JSON.stringify(seen[0]?.request.messages);
      assert.ok(firstPrompt.includes('/remote/project'));
      assert.ok(!firstPrompt.includes(options.cwd), 'remote system prompt must not advertise the host cwd');
      await submit(instance, 'local', 'server-1');
      assert.equal(recorded.calls.length, 1);
      const history = JSON.stringify(await transcript(instance.root, instance.context));
      assert.ok(history.includes('host-only content'));
      const state = await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, 'request:server-1', instance.context);
      assert.equal(state?.target?.machineId, 'server');
      assert.equal(state?.target?.cwd, options.cwd);
    } finally { await instance.close(); }
  });

  test('code mode on a remote destination returns no server path for its output files', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    // 1x1 PNG: the image is saved like the truncated output's full text.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const code = `// @options: {"max_output_tokens": 20}\ntext('x'.repeat(5000));\nimage('data:image/png;base64,${png}');`;
    const catalog = offlineModels(router({ Pi: ({ last }) => last ? say('done') : call(['codemode', { code }]) }));
    const instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true });
    const lastCodemode = async () => {
      const entries = await transcript(instance.root, instance.context);
      const results = entries.flatMap(entry => entry.model ?? [])
        .flatMap(message => message.role === 'toolResult' && message.toolName === 'codemode' ? [message] : []);
      const last = results.at(-1);
      assert.ok(last);
      return last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    };
    try {
      await submit(instance, 'remote script', 'cm-remote', laptop);
      const remote = await lastCodemode();
      assert.match(remote, /Could not save the full output: .*remote machine "My laptop"/);
      assert.match(remote, /could not be saved: .*remote machine "My laptop"/);
      assert.doesNotMatch(remote, /pi-codemode-/, 'no server temp path is offered to a remote read');
      assert.doesNotMatch(remote, /\[Full output:/);
      assert.equal(recorded.calls.length, 0, 'nothing was dispatched to the remote machine');
      await submit(instance, 'server script', 'cm-server');
      const local = await lastCodemode();
      assert.match(local, /\[Full output: .*pi-codemode-[^/]*\/output\.txt/);
      assert.match(local, /\[Image saved to .*pi-codemode-/);
    } finally { await instance.close(); }
  });

  test('the dedicated review tool dispatches only its fixed helper command to the delegated machine', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const seen: Turn[] = [];
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => user.includes('[Reviewer]') || last ? say('done')
        : call(['delegate', { agent: 'Reviewer', task: 'Review local work.' }]),
      Reviewer: ({ last }) => last ? say('Reviewed.') : call(['autoreview', { mode: 'local', base: 'candidate-base' }]),
    }, seen));
    const instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true,
      roster: { Reviewer: { model: catalog.model, thinkingLevel: 'high', tools: ['read', 'browser', 'autoreview'] } }, rosterChecks: false });
    try {
      await submit(instance, 'Review.', 'review-remote', laptop);
      await settleAgents(instance, { intervalMs: 5 });
      assert.equal(recorded.calls.length, 1);
      assert.deepEqual(recorded.calls[0]?.target, laptop);
      assert.equal(recorded.calls[0]?.name, 'bash', 'the existing guarded connector and ledger execute the fixed command');
      assert.match(String(recorded.calls[0]?.args.command), /--max-priority=P2/);
      assert.match(String(recorded.calls[0]?.args.command), /--engine=codex/);
      assert.match(String(recorded.calls[0]?.args.command), /--base=candidate-base/);
      const reviewer = seen.find(turn => turn.who === 'Reviewer');
      assert.ok(reviewer);
      const registry = await instance.harness.snapshot(AgentsDoc, instance.context);
      const id = registry?.agents.Reviewer?.conversationId;
      assert.ok(id);
      const conversation = await instance.harness.conversation(id, instance.context);
      assert.ok(conversation);
      const tools = (await conversation.agent(instance.context)).tools.map(tool => tool.name);
      assert.ok(tools.includes('autoreview'));
      for (const name of ['bash', 'write', 'edit']) assert.ok(!tools.includes(name), name);
      await instance.setTools(false);
      const state = await instance.harness.snapshot(AgentDoc, id, instance.context);
      assert.ok(Array.isArray(state?.tools));
      assert.ok(!state.tools.includes('autoreview'));
    } finally { await instance.close(); }
  });

  test('request destination is persisted before busy rejection and survives reopen', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const catalog = offlineModels([async () => { started.resolve(); await release.promise; return say('done'); }]);
    let instance = await openInstance({ ...options, ...catalog, ...recorded });
    try {
      const pending = await instance.submit('first', 'first', laptop);
      await started.promise;
      await assert.rejects(instance.submit('second', 'reserved', other), /busy/i);
      await assert.rejects(instance.submit('host', 'host-busy'), /busy/i);
      await assert.rejects(instance.submit('second', 'reserved', laptop), /destination mismatch/i);
      const state = await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, 'request:reserved', instance.context);
      assert.deepEqual(state?.target, other);
      release.resolve();
      await pending.wait(instance.context);
    } finally { release.resolve(); await instance.close(); }
    const reopened = offlineModels([say('retry done')]);
    instance = await openInstance({ ...options, ...reopened, ...recorded });
    try {
      await assert.rejects(instance.submit('second', 'reserved', laptop), /destination mismatch/i);
      await assert.rejects(instance.submit('first', 'first', { ...laptop, cwd: '/changed' }), /destination mismatch/i);
      await submit(instance, 'second', 'reserved', other);
      assert.equal(reopened.faux.state.callCount, 1);
    } finally { await instance.close(); }
  });

  test('concurrent UI sends reject busy inputs clearly, but admitted request IDs deduplicate even while busy', async t => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const catalog = offlineModels([async () => { started.resolve(); await release.promise; return say('done'); }]);
    const instance = await openInstance({ ...options, ...catalog, ...recorder() });
    const ui = await createUiSession(instance, { model: catalog.model, thinkingLevel: 'off', allowTools: false });
    const attempts = [{ text: 'one', id: 'one', target: laptop }, { text: 'two', id: 'two', target: other }];
    try {
      const results = await Promise.allSettled(attempts.map(each => ui.send(each.text, each.id, false, each.target)));
      await started.promise;
      assert.equal(results.filter(each => each.status === 'fulfilled').length, 1);
      const refused = results.find(each => each.status === 'rejected');
      assert.ok(refused?.status === 'rejected' && refused.reason instanceof Error);
      assert.match(refused.reason.message, /busy/i);
      const accepted = attempts[results.findIndex(each => each.status === 'fulfilled')];
      assert.ok(accepted);
      await ui.send(accepted.text, accepted.id, true, accepted.target);
      await assert.rejects(ui.send('same-target steer', 'same-steer', true, accepted.target), /steer.*busy routed run/i);
      await assert.rejects(ui.send('mixed-target steer', 'mixed-steer', true, accepted.target === laptop ? other : laptop), /busy routed run/i);
      await assert.rejects(ui.send('host follow-up', 'host-follow-up'), /busy/i);
      const inspection = await instance.harness.inspect(instance.context);
      assert.equal(inspection.submissions.length, 1);
      assert.equal(inspection.submissions[0]?.status, 'placed');
      assert.equal((await transcript(instance.root, instance.context)).filter(entry => entry.kind === 'pi.user').length, 1);
      release.resolve();
      await instance.root.waitForIdle(instance.context);
      assert.equal(catalog.faux.state.callCount, 1);
    } finally { release.resolve(); await ui.close(); await instance.close(); }
  });

  test('request history is stored in separate constant-size documents, not a growing namespace map', async t => {
    const options = await temporary(t);
    const catalog = offlineModels(router({ Pi: () => say('done') }));
    const instance = await openInstance({ ...options, ...catalog, ...recorder() });
    try {
      const namespace = await instance.harness.snapshot(RoutingDoc, instance.context);
      for (let index = 0; index < 20; index++) await submit(instance, `input ${index}`, String(index), index % 2 ? other : laptop);
      assert.deepEqual(await instance.harness.snapshot(RoutingDoc, instance.context), namespace);
      for (let index = 0; index < 20; index++) {
        const route = await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, `request:${index}`, instance.context);
        assert.deepEqual(route, { target: index % 2 ? other : laptop });
      }
    } finally { await instance.close(); }
  });

  test('a mixed-destination input cannot redirect a running tool round', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const catalog = offlineModels([
      async () => { started.resolve(); await release.promise; return call(['read', { path: 'never-host.txt' }]); },
      call(['read', { path: 'never-host.txt' }]),
      say('blocked'),
    ]);
    const instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true });
    try {
      const pending = await instance.submit('first', 'first', laptop);
      await started.promise;
      // Even a host caller bypassing normal busy rejection cannot mix two persisted destinations.
      await assert.rejects(instance.submit('second', 'second', other), /busy/i);
      await instance.root.submit({ type: 'input', content: 'second', requestId: 'second', whenBusy: 'steer' }, instance.context);
      release.resolve();
      await pending.wait(instance.context);
      await instance.root.waitForIdle(instance.context);
      assert.ok(recorded.calls.length <= 1, 'only the pre-steering tool round may execute');
      assert.ok(recorded.calls.every(each => each.target.machineId === 'laptop'));
      assert.match(await errors(instance), /destination mismatch/i);
    } finally { release.resolve(); await instance.close(); }
  });

  test('main and sub agents inherit pins atomically, retaining them across synchronization and reconfiguration', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const script = () => offlineModels(router({
      Pi: ({ user, last }) => user.endsWith('spawn') && !last
        ? call(['spawn_agent', { name: 'Main', task: 'delegate' }]) : say('noted'),
      Main: ({ user, last }) => user.endsWith('delegate') && !last
        ? call(['spawn_agent', { name: 'Sub', task: 'read' }])
        : user.endsWith('read again') && !last ? call(['read', { path: 'remote.txt' }]) : say('main done'),
      Sub: ({ last }) => last ? say('sub done') : call(['read', { path: 'remote.txt' }]),
    }));
    const catalog = script();
    let instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true });
    let pins;
    try {
      await submit(instance, 'spawn', 'spawn-1', laptop);
      await settleAgents(instance, { intervalMs: 1 });
      pins = await agentPins(instance);
      assert.equal(pins.length, 2);
      assert.deepEqual(pins.map(pin => pin.target), [laptop, laptop]);
      assert.deepEqual(recorded.calls.map(each => each.target), [laptop]);
      await syncAgents(instance.harness, instance.context);
      await instance.setModel(catalog.model);
      await instance.setTools(false);
      await instance.setTools(true);
      assert.deepEqual(await agentPins(instance), pins);
    } finally { await instance.close(); }
    instance = await openInstance({ ...options, ...script(), ...recorded, allowTools: true });
    try {
      assert.deepEqual(await agentPins(instance), pins);
      const agents = await instance.harness.snapshot(AgentsDoc, instance.context);
      const id = agents?.agents.Main?.conversationId;
      assert.ok(id);
      const main = await instance.harness.conversation(id, instance.context);
      assert.ok(main);
      const pending = await main.submit({ type: 'input', content: 'read again', requestId: 'again' }, instance.context);
      await pending.wait(instance.context);
      assert.equal(recorded.calls.length, 2);
      assert.deepEqual(recorded.calls[1]?.target, laptop);
      await settleAgents(instance, { intervalMs: 1 });
    } finally { await instance.close(); }
  });

  test('standing delegate pins each task session, including the first empty session and its subs, across all switches', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const faux = fauxProvider({ models: [{ id: 'root' }, { id: 'standing' }, { id: 'sub' }, { id: 'next' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const ref = (modelId: string) => ({ provider: faux.provider.id, modelId });
    faux.setResponses(router({
      Pi: ({ user, last }) => !last && (user.endsWith('one') || user.endsWith('two'))
        ? call(['delegate', { agent: 'Coder', task: user.endsWith('one') ? 'task-one' : 'task-two' }]) : say('noted'),
      Coder: ({ user, last }) => {
        if (user.startsWith('[Helper')) return say('noted');
        if (!last) return call(['spawn_agent', { name: user.endsWith('task-one') ? 'HelperOne' : 'HelperTwo', task: 'read' }]);
        return last.name === 'spawn_agent' ? call(['read', { path: 'remote.txt' }]) : say('coder done');
      },
      HelperOne: ({ last }) => last ? say('done') : call(['read', { path: 'remote.txt' }]),
      HelperTwo: ({ last }) => last ? say('done') : call(['read', { path: 'remote.txt' }]),
    }));
    const roster: Roster = { Coder: { model: ref('standing'), thinkingLevel: 'medium', tools: ['coding'],
      subModel: ref('sub'), subThinkingLevel: 'high' } };
    const settings = { ...options, models, model: ref('root'), roster, ...recorded, allowTools: true };
    let instance = await openInstance(settings);
    const initial = (await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.Coder?.conversationId;
    assert.ok(initial);
    try {
      assert.equal(await instance.harness.snapshot(AgentRouteDoc, initial, instance.context), undefined);
      await submit(instance, 'one', 'task-one', laptop);
      await settleAgents(instance, { intervalMs: 1 });
      assert.equal((await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.Coder?.conversationId, initial);
      await submit(instance, 'two', 'task-two', other);
      await settleAgents(instance, { intervalMs: 1 });
      const registry = await instance.harness.snapshot(AgentsDoc, instance.context);
      const current = registry?.agents.Coder?.conversationId;
      const helperOne = registry?.agents.HelperOne?.conversationId;
      const helperTwo = registry?.agents.HelperTwo?.conversationId;
      assert.ok(current && helperOne && helperTwo);
      assert.notEqual(current, initial);
      assert.deepEqual(registry?.agents.Coder?.past, [initial]);
      assert.equal(registry?.agents.HelperOne?.session, initial);
      assert.equal(registry?.agents.HelperTwo?.session, current);
      const expected = [[initial, laptop], [helperOne, laptop], [current, other], [helperTwo, other]] as const;
      const checkPins = async () => {
        for (const [id, target] of expected) assert.deepEqual((await instance.harness.snapshot(AgentRouteDoc, id, instance.context))?.target, target);
      };
      await checkPins();
      assert.equal(recorded.calls.filter(each => each.target.machineId === 'laptop').length, 2);
      assert.equal(recorded.calls.filter(each => each.target.machineId === 'other').length, 2);
      await instance.setModel(ref('next'));
      await instance.setThinkingLevel('low');
      await instance.setTools(false);
      await checkPins();
      await instance.setTools(true);
      await syncAgents(instance.harness, instance.context, { roster, kits: instance.kits });
      await checkPins();
      for (const id of [initial, current]) {
        const state = await instance.harness.snapshot(AgentDoc, id, instance.context);
        assert.deepEqual(state?.model, ref('standing'));
        assert.equal(state?.thinkingLevel, 'medium');
      }
      const sub = await instance.harness.snapshot(AgentDoc, helperTwo, instance.context);
      assert.deepEqual(sub?.model, ref('sub'));
      assert.equal(sub?.thinkingLevel, 'high');
      await instance.close();
      instance = await openInstance(settings);
      await checkPins();
    } finally { await instance.close(); }
  });

  test('a routed Coder report lets Pi use tools and delegate Reviewer on the same machine without another user turn', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        const input = currentText(user);
        if (input === 'start-chain') return last ? say('started') : call(['delegate', { agent: 'Coder', task: 'implement' }]);
        if (input.startsWith('[Coder]')) {
          if (!last) return call(['read', { path: 'changes.txt' }]);
          return last.name === 'read' ? call(['delegate', { agent: 'Reviewer', task: 'review changes' }]) : say('review delegated');
        }
        return say('review noted');
      },
      Coder: () => say('implemented'),
      Reviewer: ({ last }) => last ? say('reviewed') : call(['read', { path: 'changes.txt' }]),
    }));
    const roster: Roster = {
      Coder: { model: catalog.model, thinkingLevel: 'medium', tools: ['coding'] },
      Reviewer: { model: catalog.model, thinkingLevel: 'high', tools: ['read'] },
    };
    const instance = await openInstance({ ...options, ...catalog, ...recorded, roster, allowTools: true });
    try {
      await submit(instance, 'start-chain', 'chain', laptop);
      await settleAgents(instance, { intervalMs: 1 });
      assert.equal(recorded.calls.length, 2, 'the report-only root and Reviewer both read remotely');
      assert.ok(recorded.calls.every(each => each.target.machineId === laptop.machineId));
      const registry = await instance.harness.snapshot(AgentsDoc, instance.context);
      const reviewer = registry?.agents.Reviewer?.conversationId;
      assert.ok(reviewer);
      assert.deepEqual((await instance.harness.snapshot(AgentRouteDoc, reviewer, instance.context))?.target, laptop);
      const reports = (await transcript(instance.root, instance.context)).filter(entry => entry.kind === 'agents.report');
      assert.equal(reports.length, 2);
      for (const entry of reports) {
        const data = entry.data;
        assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data) && typeof data.id === 'number');
        const route = await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, `request:agents:${data.id}`, instance.context);
        assert.deepEqual(route?.target, laptop);
      }
    } finally { await instance.close(); }
  });

  test('new reports and send_message bind the exact past source session, not its standing agent current session', async t => {
    const options = await temporary(t);
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => ['one', 'two'].includes(currentText(user)) && !last
        ? call(['delegate', { agent: 'Coder', task: 'ordinary' }]) : say('noted'),
      Coder: ({ user, last }) => user.endsWith('late-old-session') && !last
        ? call(['send_message', { to: 'Pi', text: 'late message from session one' }]) : say('completed'),
    }));
    const roster: Roster = { Coder: { model: catalog.model, thinkingLevel: 'medium', tools: ['coding'] } };
    const instance = await openInstance({ ...options, ...catalog, ...recorder(), roster, allowTools: true });
    try {
      await submit(instance, 'one', 'one', laptop);
      await settleAgents(instance, { intervalMs: 1 });
      const first = (await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.Coder?.conversationId;
      assert.ok(first);
      await submit(instance, 'two', 'two', other);
      await settleAgents(instance, { intervalMs: 1 });
      assert.notEqual((await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.Coder?.conversationId, first);
      const history = await transcript(instance.root, instance.context);
      for (const entry of history.filter(each => each.kind === 'agents.report')) {
        const data = entry.data;
        assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data) && typeof data.id === 'number');
        const route = await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, `request:agents:${data.id}`, instance.context);
        assert.deepEqual(route?.target, data.session === 1 ? laptop : other, 'automatic reports remain bound after rotation');
      }
      const before = history.length;
      const old = await instance.harness.conversation(first, instance.context);
      assert.ok(old);
      const pending = await old.submit({ type: 'input', content: 'late-old-session', requestId: 'late' }, instance.context);
      await pending.wait(instance.context);
      await settleAgents(instance, { intervalMs: 1 });
      const reports = (await transcript(instance.root, instance.context)).slice(before).filter(entry => entry.kind === 'agents.report');
      assert.equal(reports.length, 1, 'an explicit message from a directly woken past session retains its source');
      for (const entry of reports) {
        const data = entry.data;
        assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data) && typeof data.id === 'number');
        assert.equal(data.session, 1);
        const route = await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id, `request:agents:${data.id}`, instance.context);
        assert.deepEqual(route?.target, laptop, 'do not inherit the current session on the other machine');
      }
    } finally { await instance.close(); }
  });

  test('an agent report steering a differently pinned host run fails closed instead of selecting either machine', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const catalog = offlineModels(router({
      Pi: async ({ user, last }) => {
        const input = currentText(user);
        if (input === 'setup') return last ? say('ready') : call(['delegate', { agent: 'Coder', task: 'ordinary' }]);
        if (input === 'hold' && !last) { started.resolve(); await release.promise; return call(['read', { path: 'before-steer.txt' }]); }
        if (input.includes('cross-machine report') && !last) return call(['read', { path: 'must-not-run.txt' }]);
        return say('noted');
      },
      Coder: ({ user, last }) => user.endsWith('report-now') && !last
        ? call(['send_message', { to: 'Pi', text: 'cross-machine report' }]) : say('completed'),
    }));
    const roster: Roster = { Coder: { model: catalog.model, thinkingLevel: 'medium', tools: ['coding'] } };
    const instance = await openInstance({ ...options, ...catalog, ...recorded, roster, allowTools: true });
    let stopWatch: (() => Promise<unknown>) | undefined;
    try {
      await submit(instance, 'setup', 'setup', other);
      await settleAgents(instance, { intervalMs: 1 });
      const pending = await instance.submit('hold', 'hold', laptop);
      await started.promise;
      const inbox = await instance.harness.watchDoc(InboxDoc, instance.root.id, instance.context);
      assert.ok(inbox);
      stopWatch = () => inbox.stop();
      const queued = Promise.withResolvers<void>();
      inbox.start(async call => { if (call.kind === 'value' && call.value.items.some(item => item.mode === 'steer')) queued.resolve(); });
      const id = (await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.Coder?.conversationId;
      assert.ok(id);
      const coder = await instance.harness.conversation(id, instance.context);
      assert.ok(coder);
      const report = await coder.submit({ type: 'input', content: 'report-now', requestId: 'report-now' }, instance.context);
      await queued.promise;
      release.resolve();
      await report.wait(instance.context);
      await pending.wait(instance.context);
      await settleAgents(instance, { intervalMs: 1 });
      assert.match(await errors(instance), /destination mismatch/i);
      assert.ok(recorded.calls.every(each => each.args.path !== 'must-not-run.txt'));
    } finally { release.resolve(); await stopWatch?.(); await instance.close(); }
  });

  test('remote browser and web_fetch refuse explicitly without running on the server; server sessions retain native kits', async t => {
    const options = await temporary(t);
    let browsed = 0;
    let fetched = 0;
    const Browser = defineExtension({ name: 'test-browser', tools: [defineTool({ name: 'browser_goto', description: 'Test browser.',
      parameters: obj({ url: str() }), execute: async () => { browsed++; return result('browsed'); } })] });
    const WebFetch = defineExtension({ name: 'test-web-fetch', tools: [defineTool({ name: 'web_fetch', description: 'Test fetch.',
      parameters: obj({ url: str() }), execute: async () => { fetched++; return result('fetched'); } })] });
    const seen: Turn[] = [];
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => !last && (user.endsWith('remote') || user.endsWith('server'))
        ? call(['delegate', { agent: 'Reviewer', task: 'browse' }], ['delegate', { agent: 'Researcher', task: 'fetch' }]) : say('noted'),
      Reviewer: ({ last }) => last ? say('done') : call(['browser_goto', { url: 'http://localhost/' }]),
      Researcher: ({ last }) => last ? say('done') : call(['web_fetch', { url: 'https://example.com/' }]),
    }, seen));
    const roster: Roster = {
      Reviewer: { model: catalog.model, thinkingLevel: 'medium', tools: ['read', 'browser'] },
      Researcher: { model: catalog.model, thinkingLevel: 'high', tools: ['web_fetch'] },
    };
    const instance = await openInstance({ ...options, ...catalog, ...recorder(), roster, allowTools: true,
      kits: { browser: { extension: Browser, tools: Browser.tools ?? [] }, web_fetch: { extension: WebFetch, tools: WebFetch.tools ?? [] } } });
    try {
      await instance.setTools(false);
      await submit(instance, 'remote', 'network-remote', laptop);
      await settleAgents(instance, { intervalMs: 1 });
      assert.equal(browsed, 0);
      assert.equal(fetched, 0);
      for (const name of ['Reviewer', 'Researcher']) {
        const response = seen.find(turn => turn.who === name && turn.last);
        assert.equal(response?.last?.isError, true);
        assert.match(response?.last?.text ?? '', /not supported on remote machine.*will not run on the server/);
      }
      await submit(instance, 'server', 'network-server');
      await settleAgents(instance, { intervalMs: 1 });
      assert.equal(browsed, 1);
      assert.equal(fetched, 1);
    } finally { await instance.close(); }
  });

  test('server native execution retains GuardedEnv protected-folder refusals', async t => {
    const options = await temporary(t);
    const secret = join(options.cwd, 'secret.txt');
    await writeFile(secret, 'NEVER_EXPOSE_THIS_SECRET');
    const recorded = recorder();
    const catalog = offlineModels([call(['read', { path: secret }]), say('refused')]);
    const instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true,
      protection: { hidden: [secret], readOnly: [] } });
    try {
      await submit(instance, 'read secret', 'guarded-server');
      assert.match(await errors(instance), /protected/);
      assert.ok(!JSON.stringify(await transcript(instance.root, instance.context)).includes('NEVER_EXPOSE_THIS_SECRET'));
      assert.equal(recorded.calls.length, 0);
    } finally { await instance.close(); }
  });

  test('an offline destination waits without host fallback, then resumes the same execution', async t => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const reconnect = Promise.withResolvers<ToolExecutionResult>();
    let calls = 0;
    const dispatcher: RoutingDispatcher = { execute(target, _id, name) {
      assert.deepEqual(target, laptop);
      assert.equal(name, 'write');
      calls++;
      started.resolve();
      return reconnect.promise;
    } };
    const catalog = offlineModels(router({ Pi: ({ last }) => last ? say('done') : call(['write', { path: 'never-host.txt', content: 'remote only' }]) }));
    const instance = await openInstance({ ...options, ...catalog, dispatcher, allowTools: true });
    try {
      const pending = await instance.submit('write', 'offline', laptop);
      await started.promise;
      await assert.rejects(access(join(options.cwd, 'never-host.txt')));
      assert.equal((await pending.status(instance.context)).status, 'placed');
      reconnect.resolve(result('reconnected'));
      assert.equal((await pending.wait(instance.context)).status, 'done');
      assert.equal(calls, 1);
      await assert.rejects(access(join(options.cwd, 'never-host.txt')));
    } finally { reconnect.resolve(result('cleanup')); await instance.close(); }
  });

  test('unmapped root/report-only runs and old unpinned agents fail closed', async t => {
    const options = await temporary(t);
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => user.endsWith('spawn') && !last
        ? call(['spawn_agent', { name: 'Old', task: 'idle' }]) : say('noted'),
      Old: () => say('idle'),
    }));
    let instance = await openInstance({ ...options, ...catalog });
    try {
      await submit(instance, 'spawn', 'old');
      await settleAgents(instance, { intervalMs: 1 });
    } finally { await instance.close(); }
    const recorded = recorder();
    const seen: Turn[] = [];
    const routedCatalog = offlineModels(router({
      Pi: ({ last }) => last ? say('blocked') : call(['read', { path: 'must-not-read' }]),
      Old: ({ last }) => last ? say('blocked') : call(['read', { path: 'must-not-read' }], ['spawn_agent', { name: 'BadSub', task: 'idle' }]),
    }, seen));
    instance = await openInstance({ ...options, ...routedCatalog, ...recorded, allowTools: true });
    try {
      const report = await instance.root.submit({ type: 'input', content: '[Old] report', requestId: 'agents:unmapped',
        entry: { kind: 'agents.report', data: { name: 'Old', text: 'report' } } }, instance.context);
      await report.wait(instance.context);
      assert.match(await errors(instance), /no pinned machine destination/);
      await assert.rejects(instance.submit('retroactive route', 'agents:unmapped', laptop), /already exists without a pinned machine/);
      const agents = await instance.harness.snapshot(AgentsDoc, instance.context);
      const id = agents?.agents.Old?.conversationId;
      assert.ok(id);
      const old = await instance.harness.conversation(id, instance.context);
      assert.ok(old);
      const pending = await old.submit({ type: 'input', content: 'try', requestId: 'unpinned' }, instance.context);
      await pending.wait(instance.context);
      await settleAgents(instance, { intervalMs: 1 });
      assert.ok(seen.filter(turn => turn.who === 'Old').at(-1)?.results.every(each => each.isError));
      assert.equal((await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.BadSub, undefined);
      assert.equal(recorded.calls.length, 0);
    } finally { await instance.close(); }
  });

  test('a cached tool registration still checks the live launch permission gate', async t => {
    const options = await temporary(t);
    const recorded = recorder();
    const catalog = offlineModels([call(['read', { path: 'never-host.txt' }]), say('blocked')]);
    const instance = await openInstance({ ...options, ...catalog, ...recorded, allowTools: true });
    try {
      const cached = (await instance.root.agent(instance.context)).tools.find(tool => tool.name === 'read');
      assert.ok(cached);
      const original = cached.execute;
      // Simulate a tool that was already resolved when /tools off committed.
      cached.execute = async (args: JsonObject, api, context) => {
        await instance.setTools(false);
        return original(args, api, context);
      };
      await submit(instance, 'probe', 'permission', laptop);
      assert.match(await errors(instance), /Coding tools are off/);
      assert.equal(recorded.calls.length, 0);
    } finally { await instance.close(); }
  });
});
