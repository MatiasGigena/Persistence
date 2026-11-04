// Small value helpers every layer uses: narrowing `unknown` and turning a thrown value into text. Here because
// src/protocol/ is already Node- and DOM-free and served to the browser, so the server, clients and web app share
// one copy.

/** A JSON object (not null, not an array), its fields still unknown. */
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** An error's message, or the thrown value as text. */
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A value of the wrong shape, from a parser that narrows `unknown`; its message names the field. */
export class ShapeError extends Error {
  override readonly name = 'ShapeError';
}

/** A Node system error's `code` (`ENOENT`, `EADDRINUSE`…), or undefined for anything else. */
export const errorCode = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;

// Narrowing helpers for parsers of external JSON (wire messages, the server's files). Each throws a ShapeError
// naming the field.

/** An object's fields, still unknown. */
export type Obj = Readonly<Record<string, unknown>>;

/** `x` as an object, or a ShapeError naming `what`. */
export function obj(x: unknown, what: string): Obj {
  if (!isRecord(x)) throw new ShapeError(`${what} must be an object`);
  return x;
}
export function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ShapeError(`${key} must be a string`);
  return v;
}
export function optStr(o: Obj, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key);
}
export function bool(o: Obj, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`${key} must be a boolean`);
  return v;
}
export function optBool(o: Obj, key: string): boolean | undefined {
  return o[key] === undefined ? undefined : bool(o, key);
}
/** A safe integer, at least `min`. */
export function int(o: Obj, key: string, min = 0): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new ShapeError(`${key} must be an integer >= ${min}`);
  return v;
}
/** A finite number. */
export function num(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`${key} must be a number`);
  return v;
}
export function optNum(o: Obj, key: string): number | undefined {
  return o[key] === undefined ? undefined : num(o, key);
}
/** An array field, each element through `item`. */
export function list<T>(o: Obj, key: string, item: (x: unknown, index: number) => T): T[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`${key} must be an array`);
  const items: readonly unknown[] = v;
  return items.map(item);
}
export function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const v = o[key];
  const found = values.find(each => each === v);
  if (found === undefined) throw new ShapeError(`${key} must be one of ${values.join(', ')}`);
  return found;
}
/** `{ ...base, [key]: value }` when `value` is defined: optional fields stay absent rather than undefined. */
export function withOptional<T extends object, K extends string, V>(base: T, key: K, value: V | undefined): T & { [P in K]?: V } {
  return value === undefined ? base : { ...base, ...{ [key]: value } };
}
