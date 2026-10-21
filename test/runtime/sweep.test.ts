import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { ARCHIVE_TTL_MS, AgentsDoc, archiveAgents } from '../../src/agents/index.ts';
import { openInstance, type Instance, type InstanceOptions } from '../../src/runtime/runtime.ts';
import { call, router, say } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

// The archive sweeper (ADR 0034): a work launch deletes agents archived for a day, then sweeps on an interval.

const T0 = Date.UTC(2026, 9, 21, 12);

async function settle({ harness, context }: Instance, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}
const names = async ({ harness, context }: Instance) => Object.keys((await harness.snapshot(AgentsDoc, context))?.agents ?? {}).sort();

describe('archive sweeper (offline)', { concurrency: false, timeout: 30_000 }, () => {
  test('a work launch deletes overdue archived agents, then sweeps on the interval until close', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-sweep-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const { models, model } = offlineModels(router({
      Pi: ({ user, last }) => {
        // The memory's view may precede the request: the last "spawn X" is this one.
        const spawn = [...user.matchAll(/spawn (\w+)/g)].at(-1)?.[1];
        return spawn && !last ? call(['spawn_agent', { name: spawn, task: 'Plan.' }]) : say('ok');
      },
      Lead: ({ last }) => last ? say('Lead done.') : call(['spawn_agent', { name: 'Sub', task: 'Part.' }]),
      Sub: () => say('Sub done.'),
      Other: () => say('Other done.'),
    }));
    let now = T0;
    const warnings: string[] = [];
    const options: InstanceOptions = { databasePath: join(cwd, 'chat.sqlite'), cwd, models, model, rosterChecks: false,
      clock: () => now, sweepMs: 20, onWarning: (message) => warnings.push(message) };
    const spawn = async (instance: Instance, name: string) => {
      await (await instance.root.submit({ type: 'input', content: `spawn ${name}` }, instance.context)).wait(instance.context);
      await settle(instance);
    };

    // A browser profile per agent name (chat.unii/browser/<name>/), with a login cookie in it.
    const profile = (name: string) => join(cwd, 'chat.unii', 'browser', name);
    const exists = (path: string) => stat(path).then(() => true, () => false);
    for (const name of ['Lead', 'Other']) {
      await mkdir(profile(name), { recursive: true });
      await writeFile(join(profile(name), 'Cookies'), 'session=secret');
    }

    let instance = await openInstance(options);
    try {
      await spawn(instance, 'Lead');
      await spawn(instance, 'Other');
      assert.deepEqual(await archiveAgents(instance.harness, instance.context, { name: 'Lead' }, T0), ['Lead', 'Sub']);
      await delay(60);
      assert.deepEqual(warnings, [], 'not a day yet');
    } finally {
      await instance.close();
    }

    // A host closed for a day deletes them at its next launch, before openInstance() resolves.
    now = T0 + ARCHIVE_TTL_MS;
    instance = await openInstance(options);
    try {
      assert.deepEqual(warnings, ['Deleted archived agents: Lead, Sub.']);
      assert.deepEqual(await names(instance), ['Other']);
      // The deleted agent's browser profile goes with it, so a new Lead would not inherit its logins.
      assert.equal(await exists(profile('Lead')), false);
      assert.equal(await exists(profile('Other')), true);
      await archiveAgents(instance.harness, instance.context, { name: 'Other' }, now);
      // The interval sweeps with the clock as it is then.
      now += ARCHIVE_TTL_MS;
      for (const end = Date.now() + 5_000; warnings.length < 2; await delay(10)) assert.ok(Date.now() < end, 'no interval sweep');
      assert.deepEqual(warnings, ['Deleted archived agents: Lead, Sub.', 'Deleted archived agents: Other.']);
      assert.deepEqual(await names(instance), []);
      assert.equal(await exists(profile('Other')), false);
    } finally {
      await instance.close();
    }
    // Closed: no sweep runs on.
    await delay(60);
    assert.equal(warnings.length, 2);

    // An inspection sweeps nothing.
    let read = false;
    const inspection = await openInstance({ ...options, configureAgent: false, clock: () => { read = true; return now; } });
    await delay(60);
    await inspection.close();
    assert.equal(read, false);
  });
});
