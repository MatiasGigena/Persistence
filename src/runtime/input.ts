// The user message a send becomes. A leaf, so routing (routing.ts) builds the same input as the runtime without
// loading the model checks and providers.
import type { UserInput } from '@earendil-works/pi-durable';
import type { ChatImage } from '../protocol/images.ts';

/** A user message's content: the text alone, or a text block (when not empty) and then the images. */
export function userInput(text: string, images: readonly ChatImage[] = []): UserInput {
  if (!images.length) return text;
  return [...text ? [{ type: 'text' as const, text }] : [], ...images.map(({ mimeType, data }) => ({ type: 'image' as const, mimeType, data }))];
}
