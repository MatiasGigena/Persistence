// The entries that carry agents' inputs (src/agents/index.ts places them): their persisted kinds and the one decoder
// of their data. Nothing here loads pi-durable, so the memory, the UI and the terminal host read them cheaply.
import { isRecord } from '../protocol/util.ts';

/** The entry kinds of agents' inputs; persisted in every chat, so frozen. */
export const REPORT_KIND = 'agents.report';
export const MESSAGE_KIND = 'agents.message';

/**
 * An agent input entry's data, decoded: a `report` from agent `from` to its parent (Pi included), or a `message` from
 * `from`. `id` is a report's delivery task ID once placed; `session` the standing agent's session (from 1) it came from.
 */
export interface AgentInput {
  readonly kind: 'report' | 'message';
  readonly from: string;
  readonly text: string;
  readonly id?: string | number;
  readonly session?: number;
}

/** The agent input an entry carries, or undefined for any other entry or for data of the wrong shape. */
export function agentInputOf(entry: { readonly kind: string; readonly data?: unknown }): AgentInput | undefined {
  const { data } = entry;
  if (!isRecord(data) || typeof data.text !== 'string') return undefined;
  const kind = entry.kind === REPORT_KIND ? 'report' : entry.kind === MESSAGE_KIND ? 'message' : undefined;
  const from = kind === 'report' ? data.name : data.from;
  if (kind === undefined || typeof from !== 'string') return undefined;
  return {
    kind, from, text: data.text,
    ...typeof data.id === 'string' || typeof data.id === 'number' ? { id: data.id } : {},
    ...typeof data.session === 'number' ? { session: data.session } : {},
  };
}
