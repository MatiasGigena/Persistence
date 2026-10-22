import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Serializable } from 'node:child_process';
import type { Message } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { BrowserContext } from 'playwright-core';
import type { Agent, EntryRecord } from '@earendil-works/pi-durable';
import {
  fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { isRecord } from '../../src/host/config.ts';
import { AgentsDoc } from '../../src/agents/index.ts';
import { DEFAULT_ROSTER } from '../../src/agents/roster.ts';
import { answerText, browserKey, localOnlyBrowser, openInstance, rosterWarnings, transcript } from '../../src/runtime/runtime.ts';
import type { Access } from '../../src/runtime/models.ts';
import type { Roster } from '../../src/agents/roster.ts';
import type { Instance } from '../../src/runtime/runtime.ts';
import { resumeInstance } from '../../src/runtime/recovery.ts';
import { offlineModels } from '../fixtures/faux-model.ts';
import type { PendingMessage } from '../fixtures/pending-submission.ts';

type Pending = Extract<PendingMessage, { type: 'pending' }>;
const isPending = (message: Serializable): message is Pending & Serializable => isRecord(message) && message.type === 'pending'
  && typeof message.rootId === 'number' && typeof message.submissionId === 'number' && typeof message.status === 'string'
  && (message.entryId === undefined || typeof message.entryId === 'number');

async function temporaryInstance(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-runtime-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'state', 'instance.sqlite') };
}

async function ask(instance: Instance, content: string, requestId?: string) {
  const submission = await instance.root.submit({ type: 'input', content, requestId }, instance.context);
  const settled = await submission.wait(instance.context);
  return { submission, settled, text: await answerText(instance.root, settled, instance.context) };
}

function textOf(entries: readonly EntryRecord[]): string[] {
  return entries.flatMap((entry) => entry.model ?? [])
    .flatMap((message) => typeof message.content === 'string'
      ? [message.content]
      : message.content.flatMap((block) => block.type === 'text' ? [block.text] : []));
}

// Serial execution is intentional: the SQLite test briefly instruments a prototype.
describe('portable durable runtime (offline)', { concurrency: false, timeout: 30_000 }, () => {
  test('reopens the same root and gives the next model the committed history', async (t) => {
    const options = await temporaryInstance(t);
    const firstCatalog = offlineModels([fauxAssistantMessage('First durable answer.')]);
    let instance = await openInstance({ ...options, ...firstCatalog });
    let rootId;
    let saved;
    try {
      rootId = instance.root.id;
      assert.equal((await ask(instance, 'Remember the blue lighthouse.', 'history-1')).text,
        'First durable answer.');
      saved = await transcript(instance.root, instance.context);
      assert.equal(saved.filter((entry) => entry.kind === 'pi.user').length, 1);
      assert.equal(saved.filter((entry) => entry.kind === 'pi.assistant').length, 1);
    } finally {
      await instance.close();
    }

    let observed: readonly Message[] = [];
    const secondCatalog = offlineModels([(context) => {
      observed = context.messages;
      return fauxAssistantMessage('Second durable answer.');
    }]);
    instance = await openInstance({ ...options, ...secondCatalog });
    try {
      assert.equal(instance.root.id, rootId);
      assert.deepEqual(await transcript(instance.root, instance.context), saved);
      assert.equal((await ask(instance, 'What do you remember?', 'history-2')).text,
        'Second durable answer.');
      // Memory reaches the model through the UniiChat view and previous exchange, not the raw transcript.
      const seen = JSON.stringify(observed);
      assert.match(seen, /<chat>/);
      assert.ok(seen.includes('blue lighthouse'));
      assert.ok(seen.includes('First durable answer.'));
      const history = await transcript(instance.root, instance.context);
      assert.deepEqual(textOf(history).filter((text) => [
        'Remember the blue lighthouse.', 'First durable answer.',
        'What do you remember?', 'Second durable answer.',
      ].includes(text)), [
        'Remember the blue lighthouse.', 'First durable answer.',
        'What do you remember?', 'Second durable answer.',
      ]);
    } finally {
      await instance.close();
    }
  });

  test('stable requestId deduplicates before and after reopen', async (t) => {
    const options = await temporaryInstance(t);
    const catalog = offlineModels([fauxAssistantMessage('Only one admission.')]);
    let instance = await openInstance({ ...options, ...catalog });
    let original;
    let history;
    try {
      original = await ask(instance, 'Submit once.', 'stable-request');
      const duplicate = await instance.root.submit({
        type: 'input', content: 'Submit once.', requestId: 'stable-request',
      }, instance.context);
      assert.equal(duplicate.id, original.submission.id);
      assert.deepEqual(await duplicate.wait(instance.context), original.settled);
      history = await transcript(instance.root, instance.context);
      assert.equal(catalog.faux.state.callCount, 1);
    } finally {
      await instance.close();
    }
    const reopenedCatalog = offlineModels();
    instance = await openInstance({ ...options, ...reopenedCatalog });
    try {
      const duplicate = await ask(instance, 'Submit once.', 'stable-request');
      assert.equal(duplicate.submission.id, original.submission.id);
      assert.equal(duplicate.settled.answer, original.settled.answer);
      assert.equal(duplicate.text, 'Only one admission.');
      assert.deepEqual(await transcript(instance.root, instance.context), history);
      assert.equal(reopenedCatalog.faux.state.callCount, 0);
    } finally {
      await instance.close();
    }
  });

  test('resume recovers queued-only input left behind by a model failure', async (t) => {
    const options = await temporaryInstance(t);
    const started = Promise.withResolvers<void>();
    const releaseFailure = Promise.withResolvers<void>();
    const catalog = offlineModels([async () => {
      started.resolve();
      await releaseFailure.promise;
      return fauxAssistantMessage('', {
        stopReason: 'error', errorMessage: 'Invalid request: deliberate offline fixture failure',
      });
    }]);
    let instance = await openInstance({ ...options, ...catalog });
    let queuedId;
    let failedId;
    let rootId;
    try {
      rootId = instance.root.id;
      const failing = await instance.root.submit({
        type: 'input', content: 'First request deliberately fails.', requestId: 'failure-before-queue',
      }, instance.context);
      failedId = failing.id;
      await started.promise;
      const queued = await instance.root.submit({
        type: 'input', content: 'Queued request must survive the failed run.',
        requestId: 'queued-after-failure', whenBusy: 'followUp',
      }, instance.context);
      queuedId = queued.id;
      assert.equal((await queued.status(instance.context)).status, 'queued');
      releaseFailure.resolve();
      const failed = await failing.wait(instance.context);
      assert.equal(failed.status, 'unanswered');
      assert.equal(failed.reason, 'model_error');
      await instance.root.waitForIdle(instance.context);
      const inspection = await instance.harness.inspect(instance.context);
      assert.equal(inspection.tasks.length, 0, 'failure leaves no task for resume() to run');
      assert.equal(inspection.submissions.length, 1);
      assert.equal(inspection.submissions[0]?.id, queuedId);
      assert.equal(inspection.submissions[0]?.status, 'queued');
      assert.equal(catalog.faux.state.callCount, 1);
    } finally {
      releaseFailure.resolve();
      await instance.close();
    }

    let modelMessages: readonly Message[] = [];
    const reopenedCatalog = offlineModels([(context) => {
      modelMessages = context.messages;
      return fauxAssistantMessage('Answered the original queued request.');
    }]);
    instance = await openInstance({ ...options, ...reopenedCatalog });
    try {
      assert.equal(instance.root.id, rootId);
      const queued = await instance.harness.submission(queuedId, instance.context);
      assert.ok(queued);
      assert.equal((await queued.status(instance.context)).status, 'queued');
      assert.equal(reopenedCatalog.faux.state.callCount, 0);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          resumeInstance(instance),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('queued-only recovery did not make progress')), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const recovered = await instance.harness.submission(queuedId, instance.context);
      assert.ok(recovered);
      assert.equal(recovered.id, queuedId);
      const settled = await recovered.status(instance.context);
      assert.equal(settled.status, 'done');
      assert.equal(await answerText(instance.root, settled, instance.context),
        'Answered the original queued request.');
      const failed = await instance.harness.submission(failedId, instance.context);
      assert.ok(failed);
      assert.equal((await failed.status(instance.context)).reason, 'model_error');
      assert.equal(reopenedCatalog.faux.state.callCount, 1);
      const history = await transcript(instance.root, instance.context);
      assert.deepEqual(textOf(history.filter((entry) => entry.kind === 'pi.user')), [
        'First request deliberately fails.', 'Queued request must survive the failed run.',
      ]);
      // The failed run is not carried raw into the next: its request is in the view, before the queued one.
      const sent = modelMessages.filter((message) => message.role === 'user')
        .map((message) => typeof message.content === 'string' ? message.content
          : message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''));
      assert.equal(sent.length, 1);
      assert.match(sent[0] ?? '', /\|user: First request deliberately fails\.\n<\/chat>/);
      assert.equal(sent[0]?.replace(/^[\s\S]*<\/turn>/, ''), 'Turn: the user\'s new message:\n\nQueued request must survive the failed run.');
      const inspection = await instance.harness.inspect(instance.context);
      assert.equal(inspection.tasks.length, 0);
      assert.equal(inspection.submissions.length, 0);
    } finally {
      await instance.close();
    }
  });

  test('coding tools require explicit opt-in and are reset on the next launch', async (t) => {
    const options = await temporaryInstance(t);
    await writeFile(join(options.cwd, 'allowed.txt'), 'disposable tool fixture');
    const coding = (agent: Agent) => agent.tools.map((tool) => tool.name).filter((name) => ['bash', 'edit', 'read', 'write'].includes(name));
    const catalog = offlineModels([
      fauxAssistantMessage(fauxToolCall('read', { path: 'allowed.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Read the disposable fixture.'),
      fauxAssistantMessage('No tools are available.'),
    ]);
    let instance = await openInstance({ ...options, ...catalog });
    try {
      const agent = await instance.root.agent(instance.context);
      assert.deepEqual(coding(agent), []);
      assert.deepEqual(agent.tools.map((tool) => tool.name).sort(),
        ['date', 'delegate', 'last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent', 'zoom']);
    } finally {
      await instance.close();
    }
    instance = await openInstance({ ...options, ...catalog, allowTools: true });
    try {
      const agent = await instance.root.agent(instance.context);
      assert.deepEqual(coding(agent).sort(), ['bash', 'edit', 'read', 'write']);
      assert.equal((await ask(instance, 'Read allowed.txt.', 'tools-on')).text,
        'Read the disposable fixture.');
      const entries = await transcript(instance.root, instance.context);
      assert.ok(entries.some((entry) => entry.kind === 'pi.tool-result'
        && JSON.stringify(entry.model).includes('disposable tool fixture')));
    } finally {
      await instance.close();
    }
    instance = await openInstance({ ...options, ...catalog });
    try {
      const agent = await instance.root.agent(instance.context);
      assert.deepEqual(coding(agent), []);
      assert.deepEqual(agent.tools.map((tool) => tool.name).sort(),
        ['date', 'delegate', 'last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent', 'zoom']);
      assert.equal((await ask(instance, 'Which tools can you use?', 'tools-off')).text,
        'No tools are available.');
      const history = await transcript(instance.root, instance.context);
      assert.equal(history.filter((entry) => entry.kind === 'pi.tool-result').length, 1);
    } finally {
      await instance.close();
    }
  });

  test('supplies every kit the built-in roster names, and closing the instance closes its browsers', async (t) => {
    const options = await temporaryInstance(t);
    const warnings: string[] = [];
    const launches: string[] = [];
    let closed = 0;
    // Just enough of a Playwright context for browser_goto: one page that navigates nowhere.
    const page = { isClosed: () => false, on: () => page, goto: () => Promise.resolve(null), url: () => 'http://127.0.0.1:9/' };
    const fake = {
      on: () => fake, pages: () => [page], close: () => { closed++; return Promise.resolve(); },
      route: () => Promise.resolve(), routeWebSocket: () => Promise.resolve(),
    };
    const instance = await openInstance({ ...options, ...offlineModels(), roster: DEFAULT_ROSTER,
      onWarning: (message) => warnings.push(message), rosterChecks: false,
      launchBrowser: (dir) => { launches.push(dir); return Promise.resolve(fake as unknown as BrowserContext); } });
    try {
      assert.deepEqual(warnings, []);
      assert.deepEqual(Object.keys(instance.kits).sort(), ['autoreview', 'browser', 'coding', 'read', 'web_fetch']);
      assert.deepEqual(instance.kits.autoreview?.tools.map(tool => tool.name), ['autoreview']);
      assert.deepEqual(instance.kits.web_fetch?.tools.map((tool) => tool.name), ['web_fetch']);
      const goto = instance.kits.browser?.tools.find((tool) => tool.name === 'browser_goto');
      assert.ok(goto);
      const api = { conversationId: ROOT_CONVERSATION_ID } as unknown as ToolExecutionApi;
      await goto.execute({ url: 'http://127.0.0.1:9/' }, api, BACKGROUND_CONTEXT);
      assert.deepEqual(launches, [join(options.databasePath.replace(/\.sqlite$/, '.unii'), 'browser', String(ROOT_CONVERSATION_ID))]);
    } finally {
      await instance.close();
    }
    assert.equal(closed, 1, 'no Chromium outlives the instance');
  });

  test('the browser is keyed on the agent: every session of it, current or past, shares one profile', async (t) => {
    const options = await temporaryInstance(t);
    const launches: string[] = [];
    const page = { isClosed: () => false, on: () => page, goto: () => Promise.resolve(null), url: () => 'http://127.0.0.1:9/' };
    const fake = {
      on: () => fake, pages: () => [page], close: () => Promise.resolve(),
      route: () => Promise.resolve(), routeWebSocket: () => Promise.resolve(),
    };
    const instance = await openInstance({ ...options, ...offlineModels(),
      launchBrowser: (dir) => { launches.push(dir); return Promise.resolve(fake as unknown as BrowserContext); } });
    const id = (n: number) => n as ConversationId;
    try {
      await instance.root.commit(async (tx) => {
        const registry = await tx.doc(AgentsDoc);
        registry.agents.Reviewer = { conversationId: id(70), past: [id(50), id(60)], role: 'main', parent: 'Pi', reported: [], standing: true };
        registry.agents.Helper = { conversationId: id(80), role: 'sub', parent: 'Reviewer', reported: [], session: id(70) };
      }, instance.context);
      const { harness, context } = instance;
      assert.equal(await browserKey(harness, id(70), context), 'Reviewer');
      assert.equal(await browserKey(harness, id(50), context), 'Reviewer');
      assert.equal(await browserKey(harness, id(60), context), 'Reviewer');
      assert.equal(await browserKey(harness, id(80), context), 'Helper');
      assert.equal(await browserKey(harness, id(99), context), '99');
      assert.equal(await browserKey(harness, ROOT_CONVERSATION_ID, context), String(ROOT_CONVERSATION_ID));
      const goto = instance.kits.browser?.tools.find((tool) => tool.name === 'browser_goto');
      assert.ok(goto);
      for (const conversationId of [50, 70, 80, 70].map(id)) {
        await goto.execute({ url: 'http://127.0.0.1:9/' }, { conversationId } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
      }
      const dir = join(options.databasePath.replace(/\.sqlite$/, '.unii'), 'browser');
      assert.deepEqual(launches, [join(dir, 'Reviewer'), join(dir, 'Helper')]);
    } finally {
      await instance.close();
    }
  });

  test('every SQLite transaction uses synchronous FULL, including after reopen', async (t) => {
    const options = await temporaryInstance(t);
    const catalog = offlineModels([fauxAssistantMessage('Durably committed.')]);
    const original = NodeSqliteDatabase.prototype.transaction;
    const modes: unknown[] = [];
    NodeSqliteDatabase.prototype.transaction = function (callback) {
      return original.bind(this)(async (tx) => {
        modes.push((await tx.get<Record<string, unknown>>('PRAGMA synchronous'))?.synchronous);
        return callback(tx);
      });
    };
    try {
      for (let launch = 0; launch < 2; launch++) {
        const before = modes.length;
        const instance = await openInstance({ ...options, ...catalog });
        try {
          if (launch === 0) await ask(instance, 'Commit with FULL.', 'full-mode');
          assert.ok(modes.length > before, 'must observe the actual runtime connection');
          assert.ok(modes.slice(before).every((mode) => mode === 2),
            `expected FULL (2), observed ${modes.slice(before)}`);
        } finally {
          await instance.close();
        }
      }
    } finally {
      NodeSqliteDatabase.prototype.transaction = original;
    }
  });

  test('transcript paginates chronologically and retains history hidden by a reset', async (t) => {
    const options = await temporaryInstance(t);
    const instance = await openInstance({ ...options, ...offlineModels() });
    try {
      await instance.root.commit(async (tx) => {
        for (let index = 0; index < 270; index++) {
          await tx.appendEntry(instance.root.id, { kind: 'test.history', data: { index } });
        }
      }, instance.context);
      await instance.root.reset(undefined, instance.context);
      await instance.root.waitForIdle(instance.context);
      const entries = await transcript(instance.root, instance.context);
      assert.deepEqual(entries.filter((entry) => entry.kind === 'test.history')
        .map((entry) => isRecord(entry.data) ? entry.data.index : undefined), Array.from({ length: 270 }, (_, index) => index));
      assert.equal(entries.at(-1)?.kind, 'pi.reset');
      assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
    } finally {
      await instance.close();
    }
  });

  test('answerText returns only committed text and rejects unanswered submissions', async (t) => {
    const options = await temporaryInstance(t);
    const catalog = offlineModels([fauxAssistantMessage([
      fauxThinking('private reasoning'), fauxText('Hello '), fauxText('world.'),
    ])]);
    const instance = await openInstance({ ...options, ...catalog });
    try {
      const { submission, settled, text } = await ask(instance, 'Say hello.', 'answer-text');
      assert.equal(text, 'Hello world.');
      assert.ok(settled.status === 'done');
      const ids = { id: submission.id, conversationId: instance.root.id };
      await assert.rejects(answerText(instance.root, {
        ...ids, type: 'input', status: 'unanswered', reason: 'aborted', detail: 'test cancellation',
      }, instance.context), /not answered.*aborted.*test cancellation/i);
      await assert.rejects(answerText(instance.root, {
        ...ids, type: 'input', status: 'placed', entry: settled.entry,
      }, instance.context), /not answered/i);
    } finally {
      await instance.close();
    }
  });

  test('SIGKILL/reopen resumes pending input without duplicate admission', async (t) => {
    const options = await temporaryInstance(t);
    const requestId = 'survives-sigkill';
    const child = fork(new URL('../fixtures/pending-submission.ts', import.meta.url), [
      options.databasePath, options.cwd, requestId,
    ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout?.resume();
    const exited: Promise<unknown[]> = once(child, 'exit');
    // Also handle rejection if startup fails before the ready IPC handshake.
    exited.catch(() => {});
    let instance: Instance | undefined;
    try {
      const ready = await new Promise<Pending>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fixture readiness timeout: ${stderr}`)), 15_000);
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
          child.off('error', onError);
        };
        const onMessage = (message: Serializable) => {
          cleanup();
          if (isPending(message)) resolve(message);
          else reject(new Error(isRecord(message) && typeof message.message === 'string' ? message.message : JSON.stringify(message)));
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(`fixture exited ${code}/${signal}: ${stderr}`));
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        child.on('message', onMessage);
        child.once('exit', onExit);
        child.once('error', onError);
      });
      assert.equal(ready.status, 'placed');
      assert.ok(ready.entryId);
      assert.ok(child.kill('SIGKILL'));
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');

      const catalog = offlineModels([fauxAssistantMessage('Recovered after SIGKILL.')]);
      instance = await openInstance({ ...options, ...catalog });
      assert.equal(instance.root.id, ready.rootId);
      // IPC carries plain numbers: find the branded ID among the unsettled submissions.
      const record = (await instance.harness.inspect(instance.context)).submissions.find((s) => s.id === ready.submissionId);
      assert.ok(record, 'admitted submission must survive abrupt process death');
      const pending = await instance.harness.submission(record.id, instance.context);
      assert.ok(pending, 'admitted submission must survive abrupt process death');
      assert.equal((await pending.status(instance.context)).status, 'placed');
      const before = await transcript(instance.root, instance.context);
      assert.equal(before.filter((entry) => entry.kind === 'pi.user').length, 1);
      assert.equal(before.filter((entry) => entry.kind === 'pi.assistant').length, 0);
      assert.equal(before.find((entry) => entry.kind === 'pi.user')?.id, ready.entryId);
      assert.equal(catalog.faux.state.callCount, 0, 'open must not start pending work before configuration');

      const retried = await instance.root.submit({
        type: 'input', content: 'Recover this pending question exactly once.', requestId,
      }, instance.context);
      assert.equal(retried.id, ready.submissionId);
      instance.harness.resume();
      const settled = await retried.wait(instance.context);
      assert.equal(await answerText(instance.root, settled, instance.context), 'Recovered after SIGKILL.');
      assert.equal(settled.entry, ready.entryId);
      assert.equal(catalog.faux.state.callCount, 1);
      const after = await transcript(instance.root, instance.context);
      assert.equal(after.filter((entry) => entry.kind === 'pi.user').length, 1);
      assert.equal(after.filter((entry) => entry.kind === 'pi.assistant').length, 1);
      assert.equal((await instance.harness.inspect(instance.context)).submissions.length, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      if (instance) await instance.close();
    }
  });

  test('roster warnings: a browser with no Chromium, an unknown model, failed or unverified credentials', async () => {
    const { models, model: known } = offlineModels();
    const faux = DEFAULT_ROSTER.Coder;
    assert.ok(faux);
    const roster: Roster = {
      Coder: { ...faux, model: known, tools: ['coding'] },
      Reviewer: { ...faux, model: known, tools: ['read', 'browser'], subModel: { provider: 'nowhere', modelId: 'x' } },
      Researcher: { ...faux, model: { provider: 'nowhere', modelId: 'y' }, tools: ['web_fetch'] },
    };
    const calls: string[] = [];
    const ok = async (access: Access) => rosterWarnings(roster, { models, exists: () => false, defaultChromium: () => '/pw/chrome',
      access: (provider) => { calls.push(provider); return Promise.resolve(access); } });
    const failing = await ok({ ok: false, reason: 'none' });
    assert.equal(failing.length, 4, failing.join('\n'));
    assert.match(failing[0] ?? '', /^Standing agent Reviewer cannot browse: Playwright's Chromium is not installed \(\/pw\/chrome\)\. Run npx --no-install playwright-core install chromium/);
    assert.match(failing[1] ?? '', /^Standing agent Reviewer's subs: Unknown model nowhere\/x.*Set another model for Reviewer in settings\.json's "agents"/);
    assert.match(failing[2] ?? '', /^Standing agent Researcher: Unknown model nowhere\/y/);
    assert.match(failing[3] ?? '', /^Standing agents Coder, Reviewer cannot run: No credentials for faux/);
    assert.deepEqual(calls, ['faux'], 'each provider is checked once');

    const unverified = await ok({ ok: false, reason: 'timeout' });
    assert.match(unverified.at(-1) ?? '', /could not verify the credentials for faux in time/);
    const fine = await rosterWarnings({ Coder: { ...faux, model: known, tools: ['browser'] } }, { models, chromium: '/opt/chrome',
      exists: (path) => path === '/opt/chrome', defaultChromium: () => { throw new Error('unused'); }, access: () => Promise.resolve({ ok: true }) });
    assert.deepEqual(fine, []);
    const badPath = await rosterWarnings({ Coder: { ...faux, model: known, tools: ['browser'] } }, { models, chromium: '/opt/none',
      exists: () => false, access: () => Promise.reject(new Error('boom')) });
    assert.match(badPath[0] ?? '', /PI_DURABLE_CHROMIUM names \/opt\/none, which does not exist/);
    assert.match(badPath[1] ?? '', /Checking the credentials for faux failed: boom/);
  });

  test('a work launch warns of the roster\'s problems without waiting for them; an inspection checks nothing', async (t) => {
    const options = await temporaryInstance(t);
    const catalog = offlineModels();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const warned = Promise.withResolvers<string>();
    const roster: Roster = { Reviewer: { model: catalog.model, thinkingLevel: 'high', tools: ['browser'] } };
    const instance = await openInstance({ ...options, ...catalog, roster, onWarning: (message) => warned.resolve(message),
      rosterChecks: { exists: () => true, defaultChromium: () => '/pw/chrome',
        access: async () => { await gate; return { ok: false, reason: 'timeout' }; } } });
    try {
      release();
      assert.match(await warned.promise, /^Standing agent Reviewer: could not verify the credentials for faux/);
    } finally {
      await instance.close();
    }
    let inspected = 0;
    const inspection = await openInstance({ ...options, ...catalog, roster, configureAgent: false, onWarning: () => { inspected++; },
      rosterChecks: { access: () => Promise.resolve({ ok: false, reason: 'none' }) } });
    await inspection.close();
    assert.equal(inspected, 0);
  });

  test('the browser is local-only for an agent that reads files, and for its subs', () => {
    const id = (n: number) => n as ConversationId;
    const agents = {
      Reviewer: { conversationId: id(2), role: 'main' as const, parent: 'Pi', reported: [], standing: true },
      Researcher: { conversationId: id(3), role: 'main' as const, parent: 'Pi', reported: [], standing: true },
      helper: { conversationId: id(4), role: 'sub' as const, parent: 'Reviewer', reported: [] },
      scout: { conversationId: id(5), role: 'sub' as const, parent: 'Researcher', reported: [] },
    };
    assert.equal(localOnlyBrowser(agents, 'Reviewer', DEFAULT_ROSTER), true);
    assert.equal(localOnlyBrowser({}, 'reviewer', DEFAULT_ROSTER), true, 'the roster counts before the registry, ignoring case');
    assert.equal(localOnlyBrowser(agents, 'helper', DEFAULT_ROSTER), true);
    assert.equal(localOnlyBrowser(agents, 'Reviewer', { Reviewer: { ...DEFAULT_ROSTER.Reviewer!, tools: ['autoreview', 'browser'] } }), true,
      'the review helper reads local files even without the read kit');
    assert.equal(localOnlyBrowser(agents, 'Researcher', DEFAULT_ROSTER), false);
    assert.equal(localOnlyBrowser(agents, 'scout', DEFAULT_ROSTER), false);
    assert.equal(localOnlyBrowser(agents, '1', DEFAULT_ROSTER), false, 'Pi browses freely');
  });
});
