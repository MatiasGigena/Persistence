// Images the user attaches in the composer (ADR 0031): pasted, dropped or picked (a phone's photo picker), turned
// into ChatImages that pass the server's check (protocol/images.ts). One that is too large, too big a picture, or of
// another type (HEIC from an iPhone) is redrawn on a canvas, scaled down to IMAGE_LIMITS.maxSide, as JPEG.
import { IMAGE_LIMITS, IMAGE_TYPES, imageProblem } from '../protocol/images.ts';
import type { ChatImage } from '../protocol/messages.ts';

/** JPEG qualities tried in turn until the image fits. */
const QUALITIES = [0.86, 0.72, 0.55] as const;

const accepted = (type: string): boolean => IMAGE_TYPES.some(each => each === type);
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/** `blob`'s bytes as base64. */
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => { if (blob) resolve(blob); else reject(new Error('The image could not be converted.')); }, type, quality);
  });
}

/** `file` as an image to send, or a rejection that says why it cannot be one. */
export async function toChatImage(file: Blob): Promise<ChatImage> {
  if (!file.type.startsWith('image/')) throw new Error('Only images can be attached.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('This image cannot be read by the browser.'); }
  try {
    const { width, height } = bitmap;
    const fits = accepted(file.type) && base64Length(file.size) <= IMAGE_LIMITS.sendBytes
      && Math.max(width, height) <= IMAGE_LIMITS.maxSide;
    if (fits) return checked({ mimeType: file.type, data: await base64(file) });
    // Redraw, smaller each round, until one encoding fits. The first round always runs, so a small picture that
    // needs converting (an oversized GIF, a HEIC) is tried at its own size.
    const first = Math.min(IMAGE_LIMITS.maxSide, Math.max(width, height));
    for (let side = first; side === first || side >= 320; side = Math.floor(side * 0.7)) {
      const scale = side / Math.max(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const draw = canvas.getContext('2d');
      if (!draw) throw new Error('The image could not be converted.');
      // JPEG has no transparency: a transparent screenshot gets a white page, not black.
      draw.fillStyle = '#ffffff';
      draw.fillRect(0, 0, canvas.width, canvas.height);
      draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const blob = await encode(canvas, 'image/jpeg', quality);
        if (base64Length(blob.size) <= IMAGE_LIMITS.sendBytes) return checked({ mimeType: 'image/jpeg', data: await base64(blob) });
      }
    }
    throw new Error('This image is too large to send, even scaled down.');
  } finally {
    bitmap.close();
  }
}

function checked(image: ChatImage): ChatImage {
  const problem = imageProblem(image);
  if (problem) throw new Error(problem);
  return image;
}

/** A `data:` URL for an image to show, or undefined when it has no data (too large for the wire) or an odd type. */
export function imageUrl(image: ChatImage): string | undefined {
  return image.data && accepted(image.mimeType) ? `data:${image.mimeType};base64,${image.data}` : undefined;
}
