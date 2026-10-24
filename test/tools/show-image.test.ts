import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { IMAGE_LIMITS } from '../../src/protocol/images.ts';
import { GuardedEnv } from '../../src/runtime/guard.ts';
import { createShowImageExtension, SHOW_IMAGE_TOOL } from '../../src/tools/show-image.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function world(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-show-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work'), secret = join(root, 'secret');
  await mkdir(work, { recursive: true });
  await mkdir(secret, { recursive: true });
  await writeFile(join(work, 'shot.png'), PNG);
  await writeFile(join(work, 'lies.png'), 'not an image at all');
  await writeFile(join(work, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMITS.fileBytes)]));
  await writeFile(join(secret, 'key.png'), PNG);
  const env = new GuardedEnv({ cwd: work, protection: { hidden: [secret], readOnly: [] } });
  const [tool] = createShowImageExtension().tools;
  assert.ok(tool);
  const run = (path: string, withEnv = true) => {
    const api = { env: withEnv ? env : undefined } as unknown as ToolExecutionApi;
    return tool.execute({ path }, api, BACKGROUND_CONTEXT);
  };
  return { work, secret, run, tool };
}

test('show_image returns an existing image file as an image block, with its path', async (t) => {
  const { work, run, tool } = await world(t);
  assert.equal(tool.name, SHOW_IMAGE_TOOL);
  const result = await run('shot.png');
  const [text, image] = result.output ?? [];
  assert.ok(text?.type === 'text' && text.text.includes(join(work, 'shot.png')));
  assert.deepEqual(image, { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') });
});

test('show_image refuses non-images, too large files, protected folders, and calls without a file environment', async (t) => {
  const { secret, run } = await world(t);
  await assert.rejects(run('lies.png'), /not a PNG, JPEG, GIF or WebP image/);
  await assert.rejects(run('huge.png'), /show_image takes at most/);
  await assert.rejects(run(join(secret, 'key.png')));
  await assert.rejects(run('missing.png'));
  await assert.rejects(run('shot.png', false), /needs a file environment/);
});

test('show_image only shows: it has no parameter to create or change an image', () => {
  const [tool] = createShowImageExtension().tools;
  assert.deepEqual(Object.keys((tool?.parameters as { properties: object }).properties), ['path']);
});
