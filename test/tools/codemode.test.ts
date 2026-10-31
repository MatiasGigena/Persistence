import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Agent, EntryRecord } from '@earendil-works/pi-durable';
import { AgentsDoc } from '../../src/agents/index.ts';
import { answerText, openInstance, transcript } from '../../src/runtime/runtime.ts';
import type { Instance } from '../../src/runtime/runtime.ts';
import { CODEMODE_TOOL_NAME, createCodemode, SCRIPT_TOOLS, scriptRefusal } from '../../src/tools/codemode.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-codemode-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'state', 'instance.sqlite') };
}

const script = (code: string) => fauxAssistantMessage(fauxToolCall(CODEMODE_TOOL_NAME, { code }), { stopReason: 'toolUse' });

async function ask(instance: Instance, content: string) {
  const submission = await instance.root.submit({ type: 'input', content }, instance.context);
  const settled = await submission.wait(instance.context);
  return answerText(instance.root, settled, instance.context);
}

/** The text of the code mode call's result, the last one in the transcript. */
async function codemodeResult(instance: Instance): Promise<{ text: string; isError: boolean }> {
  const entries: readonly EntryRecord[] = await transcript(instance.root, instance.context);
  const results = entries.flatMap(entry => entry.model ?? [])
    .flatMap(message => message.role === 'toolResult' && message.toolName === CODEMODE_TOOL_NAME ? [message] : []);
  const last = results.at(-1);
  assert.ok(last, 'the code mode call has a result');
  return { text: last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'), isError: last.isError };
}

const names = (agent: Agent, list: 'tools' | 'callable') => agent[list].map(tool => tool.name).sort();

test('scriptRefusal: model calls pass, scripts reach only SCRIPT_TOOLS', () => {
  const parent = { taskId: 1, callId: 'c' } as never;
  assert.equal(scriptRefusal({ name: 'spawn_agent' }), undefined);
  assert.equal(scriptRefusal({ name: 'read', parent }), undefined);
  for (const name of ['spawn_agent', 'delegate', 'send_message', 'show_image', 'web_fetch', 'browser_goto', CODEMODE_TOOL_NAME]) {
    assert.match(scriptRefusal({ name, parent }) ?? '', /cannot be called from a code mode script/);
  }
  assert.ok(!SCRIPT_TOOLS.includes(CODEMODE_TOOL_NAME));
});

test('the guard stops a running script\'s next call once /tools is off, and leaves model calls alone', async () => {
  let allowed = true;
  const sandbox = { close: () => Promise.resolve() } as never;
  const { extension } = createCodemode({ sandbox, allowed: () => allowed, others: ['spawn_agent'] });
  const handlers = extension.hooks?.at(-1)?.handlers as { beforeTool(call: object): unknown };
  const parent = { taskId: 1, callId: 'c' };
  assert.equal(await handlers.beforeTool({ name: 'read', parent }), undefined);
  allowed = false;
  assert.deepEqual(await handlers.beforeTool({ name: 'read', parent }), { block: 'Coding tools are off for this launch.' });
  assert.equal(await handlers.beforeTool({ name: 'read' }), undefined);
  assert.deepEqual(extension.wraps?.map(wrap => 'tool' in wrap ? wrap.tool : ''), ['spawn_agent']);
});

describe('code mode (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('comes with the coding tools only, and scripts can call only the script tools', async (t) => {
    const options = await temporary(t);
    let instance = await openInstance({ ...options, ...offlineModels() });
    try {
      const agent = await instance.root.agent(instance.context);
      assert.ok(!names(agent, 'tools').includes(CODEMODE_TOOL_NAME), 'no code mode with the tools off');
    } finally {
      await instance.close();
    }
    instance = await openInstance({ ...options, ...offlineModels(), allowTools: true });
    try {
      const agent = await instance.root.agent(instance.context);
      assert.ok(names(agent, 'tools').includes(CODEMODE_TOOL_NAME));
      assert.deepEqual(names(agent, 'callable'), [...SCRIPT_TOOLS].sort());
    } finally {
      await instance.close();
    }
  });

  test('one script calls several tools; files changed through the guarded tools', async (t) => {
    const options = await temporary(t);
    await writeFile(join(options.cwd, 'a.txt'), 'alpha');
    await writeFile(join(options.cwd, 'b.txt'), 'beta');
    const catalog = offlineModels([
      script(`const [a, b] = await Promise.all([tools.read({ path: 'a.txt' }), tools.read({ path: 'b.txt' })]);
await tools.write({ path: 'c.txt', content: a.trim() + '+' + b.trim() });
const run = await tools.bash({ command: 'cat c.txt' });
text('joined: ' + JSON.stringify(run));`),
      fauxAssistantMessage('Done.'),
    ]);
    const instance = await openInstance({ ...options, ...catalog, allowTools: true });
    try {
      assert.equal(await ask(instance, 'Join the files.'), 'Done.');
      const result = await codemodeResult(instance);
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /joined: .*alpha\+beta/);
      assert.equal(await readFile(join(options.cwd, 'c.txt'), 'utf8'), 'alpha+beta');
    } finally {
      await instance.close();
    }
  });

  test('scripts cannot spawn agents, show images, or start code mode again', async (t) => {
    const options = await temporary(t);
    const catalog = offlineModels([
      script(`const out = [];
for (const [name, args] of [['spawn_agent', { name: 'Bob', task: 'x' }], ['show_image', { path: 'x.png' }], ['codemode', { code: '1' }]]) {
  try { await tools[name](args); out.push(name + ': ran'); } catch (error) { out.push(name + ': ' + String(error.message ?? error)); }
}
text(out.join('\\n') + '\\nkeys: ' + Object.keys(tools).sort().join(','));`),
      fauxAssistantMessage('Refused.'),
    ]);
    const instance = await openInstance({ ...options, ...catalog, allowTools: true });
    try {
      // The long result may start a memory summary that takes the faux answer: only the script's result matters here.
      const submission = await instance.root.submit({ type: 'input', content: 'Try forbidden tools.' }, instance.context);
      await submission.wait(instance.context);
      const { text } = await codemodeResult(instance);
      assert.doesNotMatch(text, /: ran/);
      for (const name of ['spawn_agent', 'show_image', 'codemode']) assert.match(text, new RegExp(`${name}: tools\\.${name} does not exist`));
      assert.match(text, new RegExp(`keys: ${[...SCRIPT_TOOLS].sort().join(',')}`));
      assert.equal((await instance.harness.snapshot(AgentsDoc, instance.context))?.agents.Bob, undefined, 'no agent was spawned');
    } finally {
      await instance.close();
    }
  });

  test('protected folders stay refused inside a script', async (t) => {
    const options = await temporary(t);
    const secret = join(options.cwd, 'secret');
    await mkdir(secret);
    await writeFile(join(secret, 'key.txt'), 'TOP-SECRET');
    const catalog = offlineModels([
      script(`const out = [];
try { out.push(await tools.read({ path: ${JSON.stringify(join(secret, 'key.txt'))} })); } catch (error) { out.push('read refused'); }
const run = await tools.bash({ command: ${JSON.stringify(`cat ${join(secret, 'key.txt')} || echo bash refused`)} });
out.push(JSON.stringify(run));
text(out.join('\\n'));`),
      fauxAssistantMessage('Protected.'),
    ]);
    const instance = await openInstance({ ...options, ...catalog, allowTools: true,
      protection: { hidden: [secret], readOnly: [] } });
    try {
      assert.equal(await ask(instance, 'Read the secret.'), 'Protected.');
      const { text } = await codemodeResult(instance);
      assert.doesNotMatch(text, /TOP-SECRET/);
      assert.match(text, /read refused/);
    } finally {
      await instance.close();
    }
  });

  test('/tools off removes code mode and its script tools', async (t) => {
    const options = await temporary(t);
    const instance = await openInstance({ ...options, ...offlineModels(), allowTools: true });
    try {
      await instance.setTools(false);
      const agent = await instance.root.agent(instance.context);
      assert.ok(!names(agent, 'tools').includes(CODEMODE_TOOL_NAME));
      for (const name of ['read', 'write', 'edit', 'bash']) assert.ok(!names(agent, 'callable').includes(name));
    } finally {
      await instance.close();
    }
  });
});
