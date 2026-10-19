import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { answerText, openInstance, transcript } from '../../src/runtime/runtime.ts';
import { resumeInstance } from '../../src/runtime/recovery.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

async function temporaryInstance(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-runtime-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'state', 'instance.sqlite') };
}

async function ask(instance, content, requestId) {
  const submission = await instance.root.submit({ type: 'input', content, requestId }, instance.context);
  const settled = await submission.wait(instance.context);
  return { submission, settled, text: await answerText(instance.root, settled, instance.context) };
}

function textOf(entries) {
  return entries.flatMap((entry) => entry.model ?? [])
    .flatMap((message) => typeof message.content === 'string'
      ? [message.content]
      : message.content.filter((block) => block.type === 'text').map((block) => block.text));
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

    let observed;
    const secondCatalog = offlineModels([(context) => {
      observed = context;
      return fauxAssistantMessage('Second durable answer.');
    }]);
    instance = await openInstance({ ...options, ...secondCatalog });
    try {
      assert.equal(instance.root.id, rootId);
      assert.deepEqual(await transcript(instance.root, instance.context), saved);
      assert.equal((await ask(instance, 'What do you remember?', 'history-2')).text,
        'Second durable answer.');
      // Memory reaches the model through the UniiChat view and previous exchange, not the raw transcript.
      const seen = JSON.stringify(observed.messages);
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
    const started = Promise.withResolvers();
    const releaseFailure = Promise.withResolvers();
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
      assert.equal(inspection.submissions[0].id, queuedId);
      assert.equal(inspection.submissions[0].status, 'queued');
      assert.equal(catalog.faux.state.callCount, 1);
    } finally {
      releaseFailure.resolve();
      await instance.close();
    }

    let modelContext;
    const reopenedCatalog = offlineModels([(context) => {
      modelContext = context;
      return fauxAssistantMessage('Answered the original queued request.');
    }]);
    instance = await openInstance({ ...options, ...reopenedCatalog });
    try {
      assert.equal(instance.root.id, rootId);
      const queued = await instance.harness.submission(queuedId, instance.context);
      assert.ok(queued);
      assert.equal((await queued.status(instance.context)).status, 'queued');
      assert.equal(reopenedCatalog.faux.state.callCount, 0);
      let timer;
      try {
        await Promise.race([
          resumeInstance(instance),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('queued-only recovery did not make progress')), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const recovered = await instance.harness.submission(queuedId, instance.context);
      assert.equal(recovered.id, queuedId);
      const settled = await recovered.status(instance.context);
      assert.equal(settled.status, 'done');
      assert.equal(await answerText(instance.root, settled, instance.context),
        'Answered the original queued request.');
      const failed = await instance.harness.submission(failedId, instance.context);
      assert.equal((await failed.status(instance.context)).reason, 'model_error');
      assert.equal(reopenedCatalog.faux.state.callCount, 1);
      const history = await transcript(instance.root, instance.context);
      assert.deepEqual(textOf(history.filter((entry) => entry.kind === 'pi.user')), [
        'First request deliberately fails.', 'Queued request must survive the failed run.',
      ]);
      assert.deepEqual(modelContext.messages.filter((message) => message.role === 'user')
        .map((message) => typeof message.content === 'string' ? message.content
          : message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''))
        .map((text) => text.replace(/^[\s\S]*<\/turn>/, '')), [
        'First request deliberately fails.', 'Queued request must survive the failed run.',
      ]);
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
    const coding = (agent) => agent.tools.map((tool) => tool.name).filter((name) => ['bash', 'edit', 'read', 'write'].includes(name));
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
        ['date', 'last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent', 'zoom']);
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
        ['date', 'last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent', 'zoom']);
      assert.equal((await ask(instance, 'Which tools can you use?', 'tools-off')).text,
        'No tools are available.');
      const history = await transcript(instance.root, instance.context);
      assert.equal(history.filter((entry) => entry.kind === 'pi.tool-result').length, 1);
    } finally {
      await instance.close();
    }
  });

  test('every SQLite transaction uses synchronous FULL, including after reopen', async (t) => {
    const options = await temporaryInstance(t);
    const catalog = offlineModels([fauxAssistantMessage('Durably committed.')]);
    const original = NodeSqliteDatabase.prototype.transaction;
    const modes = [];
    NodeSqliteDatabase.prototype.transaction = function (callback) {
      return original.call(this, async (tx) => {
        modes.push((await tx.get('PRAGMA synchronous')).synchronous);
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
        .map((entry) => entry.data.index), Array.from({ length: 270 }, (_, index) => index));
      assert.equal(entries.at(-1).kind, 'pi.reset');
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
      assert.equal((await ask(instance, 'Say hello.', 'answer-text')).text, 'Hello world.');
      await assert.rejects(answerText(instance.root, {
        type: 'input', status: 'unanswered', reason: 'aborted', detail: 'test cancellation',
      }, instance.context), /not answered.*aborted.*test cancellation/i);
      await assert.rejects(answerText(instance.root, {
        type: 'input', status: 'placed',
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
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const exited = once(child, 'exit');
    // Also handle rejection if startup fails before the ready IPC handshake.
    exited.catch(() => {});
    let instance;
    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fixture readiness timeout: ${stderr}`)), 15_000);
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
          child.off('error', onError);
        };
        const onMessage = (message) => {
          cleanup();
          if (message.type === 'pending') resolve(message);
          else reject(new Error(message.message ?? JSON.stringify(message)));
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(`fixture exited ${code}/${signal}: ${stderr}`));
        };
        const onError = (error) => { cleanup(); reject(error); };
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
      const pending = await instance.harness.submission(ready.submissionId, instance.context);
      assert.ok(pending, 'admitted submission must survive abrupt process death');
      assert.equal((await pending.status(instance.context)).status, 'placed');
      const before = await transcript(instance.root, instance.context);
      assert.equal(before.filter((entry) => entry.kind === 'pi.user').length, 1);
      assert.equal(before.filter((entry) => entry.kind === 'pi.assistant').length, 0);
      assert.equal(before.find((entry) => entry.kind === 'pi.user').id, ready.entryId);
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
});
