import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wireItem } from '../../src/protocol/diff.ts';
import { IMAGE_LIMITS, imageProblem, restoreImages, sniffBase64, sniffImage, wireImage } from '../../src/protocol/images.ts';
import type { ChatItem } from '../../src/protocol/session.ts';
import { chatItem } from '../../src/protocol/parse.ts';

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

test('sniffImage knows PNG, JPEG, GIF and WebP by their magic bytes, and nothing else', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a...')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('GIF87a...')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), undefined);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(sniffImage(new Uint8Array()), undefined);
  assert.equal(sniffBase64(b64(PNG)), 'image/png');
  assert.equal(sniffBase64('not base64!'), undefined);
  assert.equal(sniffBase64('abc'), undefined, 'not a multiple of 4');
});

test('imageProblem: the type, the size, and bytes that match the type', () => {
  assert.equal(imageProblem({ mimeType: 'image/png', data: b64(PNG) }), undefined);
  assert.match(imageProblem({ mimeType: 'image/svg+xml', data: b64(PNG) }) ?? '', /PNG, JPEG, GIF or WebP, not image\/svg\+xml/);
  assert.match(imageProblem({ mimeType: 'image/jpeg', data: b64(PNG) }) ?? '', /says image\/jpeg but holds image\/png/);
  assert.match(imageProblem({ mimeType: 'image/png', data: b64(Buffer.from('plain text here')) }) ?? '', /not valid/);
  const big = b64(Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMITS.sendBytes)]));
  assert.match(imageProblem({ mimeType: 'image/png', data: big }) ?? '', /too large/);
});

test('wireImage and wireItem send a too large image without its data, and keep what fits as the same object', () => {
  const small = { mimeType: 'image/png', data: b64(PNG) };
  assert.equal(wireImage(small), small);
  const huge = { mimeType: 'image/png', data: 'A'.repeat(IMAGE_LIMITS.wireBytes + 4) };
  assert.deepEqual(wireImage(huge), { mimeType: 'image/png', data: '' });
  const user: ChatItem = { kind: 'user', id: 'u', text: 'look', images: [small] };
  assert.equal(wireItem(user), user);
  const tool: ChatItem = { kind: 'tool', id: 't', name: 'show_image', args: '{}', output: 'ok', status: 'done', images: [small, huge] };
  const wired = wireItem(tool);
  assert.ok(wired.kind === 'tool');
  assert.deepEqual(wired.images, [small, { mimeType: 'image/png', data: '' }]);
  const again = wireItem(tool);
  assert.ok(again.kind === 'tool' && again.images === wired.images, 'an unchanged list keeps one wire array');
});

test('chatItem reads images on user and tool items, and items without them have no field', () => {
  const image = { mimeType: 'image/png', data: b64(PNG) };
  assert.deepEqual(chatItem({ kind: 'user', id: 'u', text: '', images: [image] }), { kind: 'user', id: 'u', text: '', images: [image] });
  assert.deepEqual(chatItem({ kind: 'user', id: 'u', text: 'x' }), { kind: 'user', id: 'u', text: 'x' });
  assert.throws(() => chatItem({ kind: 'user', id: 'u', text: 'x', images: [{ mimeType: 1 }] }));
  assert.deepEqual(chatItem({ kind: 'tool', id: 't', name: 'n', args: '', output: '', status: 'done', images: [image] }).kind, 'tool');
});

test('restoreImages puts a failed send back before the draft, drops duplicates, and counts what does not fit', () => {
  const img = (n: number) => ({ mimeType: 'image/png', data: `${b64(PNG)}${n}` });
  const a = img(1), b = img(2), c = img(3), d = img(4), e = img(5);
  assert.deepEqual(restoreImages([], [a, b]), { images: [a, b], dropped: 0 });
  assert.deepEqual(restoreImages([c], [a, b]), { images: [a, b, c], dropped: 0 });
  assert.deepEqual(restoreImages([{ ...a }, c], [a]), { images: [a, c], dropped: 0 }, 'the same image is kept once');
  assert.deepEqual(restoreImages([c, d, e], [a, b]), { images: [a, b, c, d], dropped: 1 });
  assert.deepEqual(restoreImages([c], [a, b], 1), { images: [a], dropped: 2 });
  assert.equal(IMAGE_LIMITS.perMessage, 4);
});
