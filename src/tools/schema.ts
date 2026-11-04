// Schema pieces the tools share. Tool schemas are persisted in every chat's tool calls, so each keeps the exact JSON
// Schema it had under TypeBox (ADR 0035).
import type { Schema } from '@earendil-works/pi-schema';

/** A string literal as TypeBox wrote it (`type` and `const`), so the tool's JSON Schema stays as it was. */
export const literal = <const V extends string>(value: V): Schema<V> => ({ type: 'string', const: value });
