// The failure of a client's request, the same class in the Node clients (src/client/) and the web app (src/web/).
import type { ErrorCode } from './messages.ts';

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
