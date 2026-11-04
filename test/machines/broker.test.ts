import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import type { MachineCall, MachineCancel, MachineToolResult } from '../../src/protocol/machines.ts';
import { MachineBroker } from '../../src/server/machines.ts';
import type { MachinePeer } from '../../src/server/machines.ts';
import type { MachineTarget } from '../../src/protocol/machines.ts';

const LAPTOP: MachineTarget = { machineId: 'laptop', label: 'Laptop', cwd: '/home/me/project' };
const VPS: MachineTarget = { machineId: 'vps', label: 'VPS', cwd: '/srv/project' };
const RESULT: MachineToolResult = { output: [{ type: 'text', text: 'done' }] };

class Peer implements MachinePeer {
  isClosed = false;
  readonly sent: (MachineCall | MachineCancel)[] = [];
  sendMachine(message: MachineCall | MachineCancel): void { this.sent.push(message); }
}

async function stillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await setImmediate();
  assert.equal(settled, false, 'execution must remain pending');
}

test('broker pins calls to both machine and cwd; no host or other-connector fallback', async () => {
  const broker = new MachineBroker({ authorized: () => true });
  const laptop = new Peer(), vps = new Peer(), otherDirectory = new Peer();
  broker.register(laptop, { target: LAPTOP, enabled: true });
  broker.register(vps, { target: VPS, enabled: true });
  broker.register(otherDirectory, { target: { ...LAPTOP, cwd: '/home/me/other' }, enabled: true });
  const first = broker.execute(LAPTOP, 'chat:task-1', 'bash', { command: 'pwd' }, BACKGROUND_CONTEXT);
  const second = broker.execute(VPS, 'chat:task-2', 'read', { path: 'file' }, BACKGROUND_CONTEXT);
  assert.deepEqual(laptop.sent, [{ t: 'machine.call', id: 'chat:task-1', target: LAPTOP, name: 'bash', args: { command: 'pwd' } }]);
  assert.deepEqual(vps.sent, [{ t: 'machine.call', id: 'chat:task-2', target: VPS, name: 'read', args: { path: 'file' } }]);
  assert.deepEqual(otherDirectory.sent, []);
  broker.result(vps, { t: 'machine.result', id: 'chat:task-1', result: { isError: true } });
  broker.result(otherDirectory, { t: 'machine.result', id: 'chat:task-1', result: RESULT });
  broker.result(laptop, { t: 'machine.result', id: 'other-id', result: RESULT });
  await stillPending(first);
  broker.result(laptop, { t: 'machine.result', id: 'chat:task-1', result: RESULT });
  broker.result(vps, { t: 'machine.result', id: 'chat:task-2', result: RESULT });
  assert.deepEqual(await first, RESULT);
  assert.deepEqual(await second, RESULT);
  broker.close();
});

test('disconnected calls wait and redispatch the exact execution id only to the matching reconnect', async () => {
  const notices: string[] = [];
  const broker = new MachineBroker({ authorized: () => true, notice: text => notices.push(text) });
  const original = new Peer();
  broker.register(original, { target: LAPTOP, enabled: true });
  const pending = broker.execute(LAPTOP, 'chat:durable-9', 'write', { path: 'x', content: 'hello' }, BACKGROUND_CONTEXT);
  const call = original.sent[0];
  original.isClosed = true;
  broker.disconnected(original);
  broker.result(original, { t: 'machine.result', id: 'chat:durable-9', result: RESULT });
  const wrongMachine = new Peer(), wrongCwd = new Peer(), replacement = new Peer();
  broker.register(wrongMachine, { target: { ...LAPTOP, machineId: 'other' }, enabled: true });
  broker.register(wrongCwd, { target: { ...LAPTOP, cwd: '/other' }, enabled: true });
  assert.deepEqual(wrongMachine.sent, []);
  assert.deepEqual(wrongCwd.sent, []);
  await stillPending(pending);
  broker.register(replacement, { target: LAPTOP, enabled: true });
  assert.deepEqual(replacement.sent, [call]);
  assert.match(notices.join('\n'), /Waiting for Laptop.*execution stays pinned/);
  broker.result(original, { t: 'machine.result', id: 'chat:durable-9', result: { isError: true } });
  await stillPending(pending);
  broker.result(replacement, { t: 'machine.result', id: 'chat:durable-9', result: RESULT });
  assert.deepEqual(await pending, RESULT);
  broker.close();
});

test('tools off is authoritative: reconnect cannot restore launch permission', async () => {
  let authorized = true;
  const broker = new MachineBroker({ authorized: () => authorized });
  const old = new Peer();
  broker.register(old, { target: LAPTOP, enabled: true });
  const pending = broker.execute(LAPTOP, 'task', 'edit', { path: 'x' }, BACKGROUND_CONTEXT);
  const rejected = assert.rejects(pending, /tools are off.*reconnecting cannot restore/i);
  broker.disconnected(old);
  authorized = false;
  const replacement = new Peer();
  broker.register(replacement, { target: LAPTOP, enabled: true });
  await rejected;
  assert.deepEqual(replacement.sent, []);
  await assert.rejects(broker.execute(VPS, 'another', 'bash', {}, BACKGROUND_CONTEXT), /tools are off/i);
  broker.close();
});

test('a disabled connector waits for explicit enable; duplicate registration and retargeting are rejected', async () => {
  const broker = new MachineBroker({ authorized: () => true });
  const peer = new Peer(), duplicate = new Peer();
  broker.register(peer, { target: LAPTOP, enabled: false });
  broker.register(peer, { target: LAPTOP, enabled: false });
  assert.throws(() => broker.register(duplicate, { target: LAPTOP, enabled: true }), /active connector/);
  assert.throws(() => broker.register(peer, { target: VPS, enabled: true }), /cannot change/);
  assert.throws(() => broker.register(peer, { target: { ...LAPTOP, cwd: '/changed' }, enabled: true }), /cannot change/);
  assert.throws(() => broker.register(duplicate, { target: { ...VPS, machineId: 'server' }, enabled: true }), /reserved/);
  assert.throws(() => broker.setEnabled(duplicate, true), /Register/);
  const pending = broker.execute(LAPTOP, 'task', 'read', {}, BACKGROUND_CONTEXT);
  await stillPending(pending);
  assert.equal(peer.sent.length, 0);
  broker.setEnabled(peer, true);
  assert.equal(peer.sent[0]?.t, 'machine.call');
  broker.result(peer, { t: 'machine.result', id: 'task', result: RESULT });
  assert.deepEqual(await pending, RESULT);
  broker.close();
});

test('same pending id deduplicates only the identical payload and rejects target/tool/args reuse', async () => {
  const broker = new MachineBroker({ authorized: () => true });
  const peer = new Peer();
  broker.register(peer, { target: LAPTOP, enabled: true });
  const pending = broker.execute(LAPTOP, 'id', 'bash', { command: 'pwd' }, BACKGROUND_CONTEXT);
  assert.equal(broker.execute(LAPTOP, 'id', 'bash', { command: 'pwd' }, BACKGROUND_CONTEXT), pending);
  await assert.rejects(broker.execute(VPS, 'id', 'bash', { command: 'pwd' }, BACKGROUND_CONTEXT), /another payload/);
  await assert.rejects(broker.execute({ ...LAPTOP, cwd: '/other' }, 'id', 'bash', { command: 'pwd' }, BACKGROUND_CONTEXT), /another payload/);
  await assert.rejects(broker.execute(LAPTOP, 'id', 'read', { command: 'pwd' }, BACKGROUND_CONTEXT), /another payload/);
  await assert.rejects(broker.execute(LAPTOP, 'id', 'bash', { command: 'rm -rf x' }, BACKGROUND_CONTEXT), /another payload/);
  assert.equal(peer.sent.length, 1);
  broker.result(peer, { t: 'machine.result', id: 'id', result: RESULT });
  await pending;
  broker.close();
});

test('cancellation sends machine.cancel once, rejects the waiter, and ignores late results', async () => {
  const broker = new MachineBroker({ authorized: () => true });
  const peer = new Peer();
  broker.register(peer, { target: LAPTOP, enabled: true });
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  const pending = broker.execute(LAPTOP, 'cancel-id', 'bash', {}, context);
  const rejected = assert.rejects(pending, /cancelled.*partial side effects/i);
  cancel();
  cancel();
  await rejected;
  assert.deepEqual(peer.sent[1], { t: 'machine.cancel', id: 'cancel-id' });
  assert.equal(peer.sent.length, 2);
  broker.result(peer, { t: 'machine.result', id: 'cancel-id', result: RESULT });
  await assert.rejects(broker.execute(LAPTOP, 'pre-cancelled', 'bash', {}, context), /cancelled/i);
  broker.close();
  assert.equal(peer.sent.length, 2);
});

test('broker close cancels assigned calls, rejects unassigned calls, and refuses future work', async () => {
  const broker = new MachineBroker({ authorized: () => true });
  const peer = new Peer();
  broker.register(peer, { target: LAPTOP, enabled: true });
  const assigned = broker.execute(LAPTOP, 'assigned', 'read', {}, BACKGROUND_CONTEXT);
  const absent = broker.execute(VPS, 'absent', 'write', {}, BACKGROUND_CONTEXT);
  const rejectedAssigned = assert.rejects(assigned, /server closed.*partially run/i);
  const rejectedAbsent = assert.rejects(absent, /server closed/i);
  broker.close();
  broker.close();
  await Promise.all([rejectedAssigned, rejectedAbsent]);
  assert.deepEqual(peer.sent[1], { t: 'machine.cancel', id: 'assigned' });
  assert.equal(peer.sent.length, 2);
  assert.throws(() => broker.register(new Peer(), { target: LAPTOP, enabled: true }), /closed/);
  await assert.rejects(broker.execute(LAPTOP, 'new', 'read', {}, BACKGROUND_CONTEXT));
});

test('invalid remote tools and server destination never dispatch', async () => {
  const broker = new MachineBroker({ authorized: () => true });
  for (const name of ['zoom', 'spawn_agent', 'shell', 'BASH', '__proto__', '']) {
    await assert.rejects(broker.execute(LAPTOP, 'id', name, {}, BACKGROUND_CONTEXT), /Invalid remote/);
  }
  await assert.rejects(broker.execute({ ...LAPTOP, machineId: 'server' }, 'id', 'bash', {}, BACKGROUND_CONTEXT), /Invalid remote/);
  broker.close();
});
