import { isRecord, ShapeError } from './util.ts';

/** Where a request's tools run: a machine (`server` is the host itself) and a folder on it, with a label to show. */
export interface MachineTarget {
  readonly machineId: string;
  readonly cwd: string;
  readonly label: string;
}

export type JsonData = null | boolean | number | string | JsonData[] | { [key: string]: JsonData };
export const MACHINE_TOOLS = ['read', 'write', 'edit', 'bash'] as const;
export type MachineToolName = typeof MACHINE_TOOLS[number];

export interface MachineRegistration {
  readonly target: MachineTarget;
  /** Permission for this client process only; never restored from disk. */
  readonly enabled: boolean;
}

/** The subset of a durable tool result accepted from an execution machine. */
export interface MachineToolResult {
  readonly output?: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  readonly structuredOutput?: JsonData;
  readonly details?: JsonData;
  readonly isError?: boolean;
  readonly diagnostics?: { severity: 'info' | 'warn' | 'error'; message: string; code?: string }[];
}

export interface MachineCall {
  readonly t: 'machine.call';
  /** Persistent chat namespace plus durable tool task id, not a connection-local counter. */
  readonly id: string;
  readonly target: MachineTarget;
  readonly name: MachineToolName;
  readonly args: { [key: string]: JsonData };
}
export interface MachineResult { readonly t: 'machine.result'; readonly id: string; readonly result: MachineToolResult }
export interface MachineCancel { readonly t: 'machine.cancel'; readonly id: string }

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ShapeError(`Invalid ${what}`);
  }
  return value;
}
export function machineTarget(value: unknown): MachineTarget {
  if (!isRecord(value)) throw new ShapeError('Invalid machine target');
  const machineId = text(value.machineId, 128, 'machine id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(machineId)) throw new ShapeError('Invalid machine id');
  const cwd = text(value.cwd, 4096, 'machine directory');
  if (!cwd.startsWith('/')) throw new ShapeError('Machine directory must be absolute');
  return { machineId, cwd, label: text(value.label, 256, 'machine label') };
}
export function machineRegistration(value: unknown): MachineRegistration {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') throw new ShapeError('Invalid machine registration');
  const target = machineTarget(value.target);
  if (target.machineId === 'server') throw new ShapeError('The machine id server is reserved');
  return { target, enabled: value.enabled };
}
export function jsonData(value: unknown, depth = 0): JsonData {
  if (depth > 64) throw new ShapeError('JSON nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return (value as unknown[]).map(item => jsonData(item, depth + 1));
  if (!isRecord(value)) throw new ShapeError('Invalid JSON value');
  const entries = Object.entries(value).map(([key, item]) => [key, jsonData(item, depth + 1)] as const);
  return Object.fromEntries(entries);
}
export function machineToolResult(value: unknown): MachineToolResult {
  if (!isRecord(value)) throw new ShapeError('Invalid machine result');
  const result: { output?: MachineToolResult['output']; structuredOutput?: JsonData; details?: JsonData; isError?: boolean; diagnostics?: MachineToolResult['diagnostics'] } = {};
  if (value.isError !== undefined) {
    if (typeof value.isError !== 'boolean') throw new ShapeError('Invalid tool error flag');
    result.isError = value.isError;
  }
  if (value.output !== undefined) {
    if (!Array.isArray(value.output)) throw new ShapeError('Invalid tool output');
    result.output = (value.output as unknown[]).map(item => {
      if (!isRecord(item)) throw new ShapeError('Invalid output block');
      if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        if (!/^image\/(png|jpeg|gif|webp|bmp)$/u.test(item.mimeType) || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(item.data)) throw new ShapeError('Invalid image output');
        return { type: 'image', data: item.data, mimeType: item.mimeType };
      }
      throw new ShapeError('Invalid output block');
    });
  }
  if (value.structuredOutput !== undefined) result.structuredOutput = jsonData(value.structuredOutput);
  if (value.details !== undefined) result.details = jsonData(value.details);
  if (value.diagnostics !== undefined) {
    if (!Array.isArray(value.diagnostics)) throw new ShapeError('Invalid tool diagnostics');
    result.diagnostics = (value.diagnostics as unknown[]).map(item => {
      if (!isRecord(item) || (item.severity !== 'info' && item.severity !== 'warn' && item.severity !== 'error') || typeof item.message !== 'string'
        || (item.code !== undefined && typeof item.code !== 'string')) throw new ShapeError('Invalid tool diagnostic');
      return { severity: item.severity, message: item.message, ...typeof item.code === 'string' ? { code: item.code } : {} };
    });
  }
  return result;
}
export function machineCall(value: unknown): MachineCall {
  if (!isRecord(value) || !isRecord(value.args)) throw new ShapeError('Invalid machine call');
  const name = MACHINE_TOOLS.find(each => each === value.name);
  if (!name) throw new ShapeError('Unknown machine tool');
  const args = jsonData(value.args);
  if (!isRecord(args)) throw new ShapeError('Invalid machine arguments');
  return { t: 'machine.call', id: text(value.id, 512, 'execution id'), target: machineTarget(value.target), name, args };
}
export function executionId(value: unknown): string { return text(value, 512, 'execution id'); }
