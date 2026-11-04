// Small value helpers every layer uses: narrowing `unknown` and turning a thrown value into text. Here because
// src/protocol/ is already Node- and DOM-free and served to the browser, so the server, clients and web app share
// one copy.
import type { ErrorCode } from './messages.ts';

/** A JSON object (not null, not an array), its fields still unknown. */
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** An error's message, or the thrown value as text. */
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A value of the wrong shape, from a parser that narrows `unknown`; its message names the field. */
export class ShapeError extends Error {
  override readonly name = 'ShapeError';
}

/**
 * A client's request that failed (src/client/ and src/web/ alike): the server's error code, `disconnected` (the link
 * dropped before the answer) or `timeout` (no answer in time).
 */
export class RequestError extends Error {
  override readonly name = 'RequestError';
  readonly code: ErrorCode | 'disconnected' | 'timeout';
  constructor(code: RequestError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** A Node system error's `code` (`ENOENT`, `EADDRINUSE`…), or undefined for anything else. */
export const errorCode = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;
