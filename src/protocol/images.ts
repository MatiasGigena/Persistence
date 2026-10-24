// Images on the wire and in the chat: the accepted types, their magic bytes, and the size caps. Shared by Node
// (server, tools) and the browser (web composer), so no Node or DOM imports.
import type { ChatImage } from '../ui/types.ts';

/** The image types Persistence accepts: what the model providers take. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = typeof IMAGE_TYPES[number];

/** Caps on images. Sizes are base64 characters (UTF-16 code units), which is what a frame and a row hold. */
export const IMAGE_LIMITS = {
  /** Images per sent message. */
  perMessage: 4,
  /** One image a client sends: well under LIMITS.clientMessage, so four fit in one frame. */
  sendBytes: 900 * 1024,
  /**
   * One image as it goes on the wire in a ChatItem; a larger one (a full-page browser screenshot) goes with empty
   * `data`, and clients show a placeholder.
   */
  wireBytes: 3 * 1024 * 1024,
  /** One file show_image reads, raw bytes: its base64 is at most wireBytes, so what it shows always reaches the chat. */
  fileBytes: 3 * 1024 * 1024 * 3 / 4,
  /** Longest side the web composer scales a pasted image down to. */
  maxSide: 2000,
} as const;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  prefix.every((byte, k) => bytes[at + k] === byte);

/** The image type `bytes` start with (magic bytes), or undefined for anything else. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The first bytes of base64 `data` (at most 16), or undefined when `data` is not base64. */
function head(data: string): Uint8Array | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const chars = data.slice(0, 24).replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const char of chars) {
    value = (value << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

/** The type base64 `data` holds by its magic bytes, or undefined when it is not base64 or not an accepted image. */
export function sniffBase64(data: string): ImageType | undefined {
  const bytes = head(data);
  return bytes && sniffImage(bytes);
}

/**
 * Why `image` is not an acceptable sent image, or undefined when it is: base64 of an accepted type whose bytes
 * match its `mimeType`, at most IMAGE_LIMITS.sendBytes.
 */
export function imageProblem(image: ChatImage, max: number = IMAGE_LIMITS.sendBytes): string | undefined {
  if (!IMAGE_TYPES.some(type => type === image.mimeType)) return `Images must be PNG, JPEG, GIF or WebP, not ${image.mimeType}.`;
  if (image.data.length > max) return `An image is too large (${kib(image.data.length)}; at most ${kib(max)}).`;
  const sniffed = sniffBase64(image.data);
  if (!sniffed) return 'An image is not valid PNG, JPEG, GIF or WebP data.';
  if (sniffed !== image.mimeType) return `An image says ${image.mimeType} but holds ${sniffed}.`;
  return undefined;
}

const kib = (chars: number): string => `${Math.ceil(chars * 3 / 4 / 1024)} KiB`;

/** `image` as it goes on the wire: the same object, or with empty `data` when larger than IMAGE_LIMITS.wireBytes. */
export function wireImage(image: ChatImage): ChatImage {
  return image.data.length <= IMAGE_LIMITS.wireBytes ? image : { mimeType: image.mimeType, data: '' };
}

/**
 * A failed send's `failed` images merged back into the composer's `draft` ones, the failed first (they were sent
 * earlier), with duplicates removed and at most `max` kept; `dropped` counts those that did not fit, so the caller
 * can say so instead of losing them silently.
 */
export function restoreImages(
  draft: readonly ChatImage[], failed: readonly ChatImage[], max: number = IMAGE_LIMITS.perMessage,
): { readonly images: ChatImage[]; readonly dropped: number } {
  const merged: ChatImage[] = [];
  for (const image of [...failed, ...draft]) {
    if (!merged.some(each => each === image || (each.mimeType === image.mimeType && each.data === image.data))) merged.push(image);
  }
  return { images: merged.slice(0, max), dropped: Math.max(0, merged.length - max) };
}
