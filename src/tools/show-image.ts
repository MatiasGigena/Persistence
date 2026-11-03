import { defineTool } from '@earendil-works/pi-durable';
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { IMAGE_LIMITS, sniffImage } from '../protocol/images.ts';

/**
 * `show_image(path)`: shows the user an existing image file (a screenshot, a photo on disk) in the chat, and gives it
 * to the model too. PNG, JPEG, GIF or WebP by their magic bytes, at most IMAGE_LIMITS.fileBytes. It reads through the
 * tools' environment (GuardedEnv), so protected folders stay hidden. It never creates or edits an image (ADR 0031).
 */

/** Persisted names (ADR 0031): never rename. */
export const SHOW_IMAGE_EXTENSION = 'show-image';
export const SHOW_IMAGE_TOOL = 'show_image';

export type ShowImageExtension = Extension & { readonly tools: readonly ToolRegistration[] };

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function createShowImageExtension(): ShowImageExtension {
  const tool = defineTool({
    name: SHOW_IMAGE_TOOL,
    description: 'Show the user an existing image file (PNG, JPEG, GIF or WebP, at most '
      + `${mib(IMAGE_LIMITS.fileBytes)}) in the chat; you see it too. For screenshots or pictures already on disk; it `
      + 'cannot create or change images.',
    parameters: obj({ path: str({ minLength: 1, description: 'The image file; absolute or relative to the working directory.' }) }),
    executionMode: 'sequential',
    async execute({ path }, api, context) {
      const env = api.env;
      if (!env) throw new Error('show_image needs a file environment, and this call has none.');
      const absolute = getOrThrow(await env.absolutePath(path, context));
      const reader = getOrThrow(await env.openBinaryReader(absolute, { noFollow: false }, context));
      try {
        const { size } = getOrThrow(await reader.info(context));
        if (size > IMAGE_LIMITS.fileBytes) throw new Error(`${path} is ${mib(size)}; show_image takes at most ${mib(IMAGE_LIMITS.fileBytes)}.`);
        const bytes = getOrThrow(await reader.read(0, size, context));
        const mimeType = sniffImage(bytes);
        if (!mimeType) throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image.`);
        return {
          output: [
            { type: 'text', text: `Shown to the user: ${absolute} (${mimeType}, ${bytes.length} bytes)` },
            { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType },
          ],
          details: { path: absolute, mimeType, bytes: bytes.length },
        };
      } finally {
        await reader.close(context);
      }
    },
  });
  return { name: SHOW_IMAGE_EXTENSION, tools: [tool] };
}
