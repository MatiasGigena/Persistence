import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai';
import type { Credential, MutableModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { claudeCliProvider } from '../../src/providers/claude-cli.ts';
import { imagesProblem, modelChooser } from '../../src/runtime/models.ts';
import { userInput } from '../../src/runtime/input.ts';
import type { ModelOption } from '../../src/runtime/models.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));

/** pi-ai's real providers over a fixed credential store and environment, plus claude-cli on the fake CLI. */
async function catalog(t: TestContext, { vars = {}, credentials = {}, loggedIn = true }: {
  vars?: Record<string, string>; credentials?: Record<string, Credential>; loggedIn?: boolean;
} = {}): Promise<{ models: MutableModels; authCalls: () => Promise<number> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-models-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude'), log = join(dir, 'calls.jsonl');
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  await writeFile(log, '');
  const env = { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn, authMethod: 'claude.ai' }) };
  const models = createModels({
    credentials: { read: async (id: string) => credentials[id], list: async () => [], modify: async () => { throw new Error('no writes'); }, delete: async () => {} },
    authContext: { env: async (name: string) => vars[name], fileExists: async () => false },
  });
  for (const provider of [claudeCliProvider({ env, bin }), openaiCodexProvider(), openaiProvider(), anthropicProvider()]) models.setProvider(provider);
  const authCalls = async () => (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"auth"')).length;
  return { models, authCalls };
}

const byKey = (list: readonly ModelOption[]) => new Map(list.map(option => [`${option.provider}/${option.id}`, option]));
const providers = (list: readonly ModelOption[]) => [...new Set(list.map(option => option.provider))];

describe('model chooser', { timeout: 30_000 }, () => {
  test('lists the sensible routes, current first, and marks availability with notes', async (t) => {
    const { models, authCalls } = await catalog(t);
    const chooser = modelChooser(models);
    const list = await chooser.list({ provider: 'openai-codex', modelId: 'gpt-6.1-sol' });
    assert.deepEqual(list[0] && [list[0].provider, list[0].id], ['openai-codex', 'gpt-6.1-sol']);
    // openai has no key, so it is left out; dated snapshots are left out.
    assert.deepEqual(providers(list), ['openai-codex', 'claude-cli', 'anthropic']);
    const listed = byKey(list);
    assert.equal(listed.get('anthropic/claude-haiku-4-5-20251001'), undefined);
    assert.ok(listed.get('anthropic/claude-haiku-4-5'));
    assert.deepEqual(list.filter(option => option.provider === 'claude-cli').map(option => option.id), ['opus', 'sonnet', 'haiku', 'fable']);

    assert.deepEqual(listed.get('claude-cli/sonnet'), { provider: 'claude-cli', id: 'sonnet', name: 'Claude Sonnet 5.5 (Claude Code)',
      available: true, note: 'uses your Claude plan via the claude CLI' });
    assert.equal(listed.get('openai-codex/gpt-6.1-sol')?.available, false);
    assert.equal(listed.get('openai-codex/gpt-6.1-sol')?.note, 'needs a Pi login (/login in pi)');
    assert.deepEqual([listed.get('anthropic/claude-sonnet-5-5')?.available, listed.get('anthropic/claude-sonnet-5-5')?.note],
      [false, 'needs ANTHROPIC_API_KEY']);

    // One claude auth check serves both listings (cached per provider).
    await chooser.list({ provider: 'claude-cli', modelId: 'haiku' });
    assert.equal(await authCalls(), 1);
  });

  test('the current provider leads; openai shows with a key; anthropic only with an API key', async (t) => {
    const keyed = await catalog(t, { vars: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-api03-x' }, loggedIn: false });
    const list = await modelChooser(keyed.models).list({ provider: 'anthropic', modelId: 'claude-sonnet-5-5' });
    assert.deepEqual(providers(list), ['anthropic', 'claude-cli', 'openai-codex', 'openai']);
    assert.deepEqual([list[0]?.id, list[0]?.available, list[0]?.note], ['claude-sonnet-5-5', true, undefined]);
    assert.equal(byKey(list).get('openai/gpt-4o')?.available, true);
    assert.deepEqual([byKey(list).get('claude-cli/opus')?.available, byKey(list).get('claude-cli/opus')?.note], [false, 'needs claude auth login']);

    const refused = await catalog(t, { vars: { ANTHROPIC_API_KEY: 'sk-ant-oat01-x' } });
    const sonnet = byKey(await modelChooser(refused.models).list({ provider: 'claude-cli', modelId: 'sonnet' })).get('anthropic/claude-sonnet-5-5');
    assert.deepEqual([sonnet?.available, sonnet?.note], [false, 'subscription login refused; use claude-cli']);
    const oauth = await catalog(t, { credentials: { anthropic: { type: 'oauth', access: 'sk-ant-oat01-x', refresh: 'r', expires: 0 } } });
    await assert.rejects(modelChooser(oauth.models).check({ provider: 'anthropic', modelId: 'claude-sonnet-5-5' }),
      /Refusing anthropic\/claude-sonnet-5-5: its credential is a Claude subscription/);
  });

  test('check names unknown models and missing credentials', async (t) => {
    const { models } = await catalog(t, { loggedIn: false });
    const chooser = modelChooser(models, { authFile: '/x/auth.json' });
    await assert.rejects(chooser.check({ provider: 'claude-cli', modelId: 'gpt' }), /Unknown model claude-cli\/gpt\. Use opus, sonnet, haiku or fable\./);
    await assert.rejects(chooser.check({ provider: 'nobody', modelId: 'x' }), /Unknown model nobody\/x in pinned Pi 1\.5\.0 catalog/);
    await assert.rejects(chooser.check({ provider: 'claude-cli', modelId: 'haiku' }), /No Claude Code login for claude-cli/);
    await assert.rejects(chooser.check({ provider: 'openai-codex', modelId: 'gpt-6.1-sol' }), /No credentials for openai-codex\..*Auth file: \/x\/auth\.json/);
    // Pi's /login for anthropic is the Claude Pro/Max login the host refuses: point at an API key or claude-cli instead.
    await assert.rejects(chooser.check({ provider: 'anthropic', modelId: 'claude-sonnet-5-5' }), (error: Error) => {
      assert.match(error.message, /^No credentials for anthropic\. Set ANTHROPIC_API_KEY to an Anthropic Console API key/);
      assert.match(error.message, /claude-cli\/opus/);
      assert.doesNotMatch(error.message, /then \/login/);
      return true;
    });
  });

  test('a claude-cli check that hangs names the command that hung', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-durable-models-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, 'claude');
    await writeFile(bin, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
    const models = createModels();
    models.setProvider(claudeCliProvider({ env: process.env, bin }));
    await assert.rejects(modelChooser(models).check({ provider: 'claude-cli', modelId: 'opus' }, { timeoutMs: 100 }), { message:
      'Checking the credentials for claude-cli timed out: claude auth status did not answer. Run it yourself to see why.' });
  });

  test('a credential check that hangs is unavailable after the timeout', async () => {
    const faux = fauxProvider({ models: [{ id: 'slow' }] });
    const models = createModels();
    models.setProvider({ ...faux.provider, auth: { apiKey: { name: 'Hangs', resolve: () => new Promise(() => {}) } } });
    const list = await modelChooser(models, { timeoutMs: 50 }).list({ provider: 'faux', modelId: 'slow' });
    assert.deepEqual(list, [{ provider: 'faux', id: 'slow', name: 'slow', available: false, note: 'credential check timed out' }]);
  });
});

describe('images in a user message (ADR 0031)', () => {
  test('userInput: text alone stays a string; with images, a text block (when any) and then the images', () => {
    const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
    assert.equal(userInput('hi'), 'hi');
    assert.deepEqual(userInput('hi', [image]), [{ type: 'text', text: 'hi' }, { type: 'image', ...image }]);
    assert.deepEqual(userInput('', [image]), [{ type: 'image', ...image }]);
  });

  test('imagesProblem: none for a model that takes images; a clear error for one that does not', () => {
    const faux = fauxProvider({ models: [{ id: 'sees', input: ['text', 'image'] }, { id: 'blind', input: ['text'] }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const provider = faux.getModel().provider;
    assert.equal(imagesProblem(models, { provider, modelId: 'sees' }), undefined);
    assert.match(imagesProblem(models, { provider, modelId: 'blind' }) ?? '', /does not take images; nothing was sent/);
    assert.match(imagesProblem(models, { provider, modelId: 'gone' }) ?? '', /does not take images/);
  });
});
