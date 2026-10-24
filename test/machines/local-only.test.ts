import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness, ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import { createMachineRouting } from '../../src/machines/routing.ts';
import { whileAllowed } from '../../src/runtime/runtime.ts';
import { createShowImageExtension } from '../../src/tools/show-image.ts';

const cwd = '/srv/project';
const host = { machineId: 'server', cwd, label: 'server' };

/** show_image whose real execution only counts: the test is about the permission checks around it. */
function counted() {
  let runs = 0;
  const extension = createShowImageExtension();
  const [tool] = extension.tools;
  assert.ok(tool);
  const fake: ToolRegistration = { ...tool, execute: () => { runs++; return Promise.resolve({ output: [{ type: 'text', text: 'shown' }] }); } };
  return { extension: { ...extension, tools: [fake] }, runs: () => runs };
}

test('routed show_image rechecks permission after its destination resolves: /tools off stops a call in progress', async () => {
  const gate = Promise.withResolvers<void>();
  const asked = Promise.withResolvers<void>();
  // An agent session's route is one snapshot; it stays pending until the test has switched the tools off.
  const harness = { snapshot: async () => { asked.resolve(); await gate.promise; return { target: host }; } } as unknown as Harness;
  let allowed = true;
  const routing = createMachineRouting({ dispatcher: { execute: () => Promise.reject(new Error('no dispatch')) }, cwd,
    harness: () => harness, allowTools: () => allowed });
  const { extension, runs } = counted();
  const [tool] = routing.localOnly(extension, () => allowed).tools ?? [];
  assert.ok(tool);
  const api = { conversationId: 'agent-1' } as unknown as ToolExecutionApi;
  const call = tool.execute({ path: 'shot.png' }, api, BACKGROUND_CONTEXT);
  await asked.promise;
  allowed = false;
  gate.resolve();
  await assert.rejects(call, /Coding tools are off for this launch/);
  assert.equal(runs(), 0);

  // Off before the call: it refuses without resolving anything.
  await assert.rejects(tool.execute({ path: 'shot.png' }, api, BACKGROUND_CONTEXT), /Coding tools are off/);
  allowed = true;
  await tool.execute({ path: 'shot.png' }, api, BACKGROUND_CONTEXT);
  assert.equal(runs(), 1);
});

test('unrouted show_image (whileAllowed) refuses once the tools are off', async () => {
  let allowed = true;
  const { extension, runs } = counted();
  const [tool] = whileAllowed(extension, () => allowed).tools ?? [];
  assert.ok(tool);
  const api = {} as unknown as ToolExecutionApi;
  await tool.execute({ path: 'a.png' }, api, BACKGROUND_CONTEXT);
  allowed = false;
  await assert.rejects(tool.execute({ path: 'a.png' }, api, BACKGROUND_CONTEXT), /Coding tools are off/);
  assert.equal(runs(), 1);
});
