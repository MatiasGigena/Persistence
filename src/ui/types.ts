// The contract between the host's state (src/ui/session.ts) and the terminal UI (src/ui/tui/).
// The session knows pi-durable, memory and agents; the TUI knows only these types.
import type { AgentInfo } from '../agents/index.ts';
import type { MemoryStatus } from '../memory/index.ts';

/** One block of a conversation, in order. Streaming blocks are updated in place by `id`. */
export type ChatItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: 'thinking'; readonly id: string; readonly text: string; readonly streaming: boolean }
  | {
    readonly kind: 'tool'; readonly id: string; readonly name: string;
    /** Arguments as compact JSON, possibly partial while streaming. */
    readonly args: string;
    readonly output: string;
    readonly status: 'running' | 'done' | 'error';
  }
  /** An agent's report or message, "[Name] text", reaching this conversation. */
  | { readonly kind: 'report'; readonly id: string; readonly from: string; readonly text: string }
  /** Host notices: errors, retries, "work resumed", and so on. */
  | { readonly kind: 'notice'; readonly id: string; readonly text: string; readonly level: 'info' | 'warn' | 'error' };

/** Everything the footer and panels show besides the chat. */
export interface SessionStatus {
  /** "provider/modelId". */
  readonly model: string;
  readonly thinkingLevel: string;
  readonly toolsEnabled: boolean;
  /** A run is working on Pi's conversation. */
  readonly busy: boolean;
  /** Inputs queued behind the running one. */
  readonly queued: number;
  readonly memory: MemoryStatus | undefined;
  readonly agents: readonly AgentInfo[];
}

/** A model Pi can switch to. */
export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
  /** Display name from the catalog, e.g. "Claude Sonnet (CLI)". */
  readonly name: string;
  /** Credentials for its provider are present. Unavailable models are listed but cannot be picked. */
  readonly available: boolean;
  /** A short hint, e.g. "uses your Claude plan" or "needs ANTHROPIC_API_KEY". */
  readonly note?: string;
}

/** One line of the memory view: `id+n|text`. */
export interface ViewLine {
  readonly id: number;
  readonly n: number;
  readonly text: string;
}

/** What a conversation looks like to the UI: the root (Pi) or one agent. */
export interface ChatFeed {
  /** The current items, oldest first. */
  items(): readonly ChatItem[];
  /** Called after any change to `items()`. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

/** The UI's whole view of the host. Implemented by src/ui/session.ts. */
export interface UiSession {
  /** Pi's conversation. */
  readonly chat: ChatFeed;
  status(): SessionStatus;
  /** Called after any change to `status()`. Returns an unsubscribe function. */
  onStatus(listener: () => void): () => void;
  /** Sends text to Pi: starts a run, or follows up the running one. */
  send(text: string): Promise<void>;
  /** Interrupts Pi's running work (Esc). Durable work stays resumable. */
  abort(): Promise<void>;
  /**
   * Stops one agent and its sub agents, or every agent when `name` is omitted; Pi is not touched.
   * Resolves with the names stopped, sub agents first; empty for an unknown name.
   */
  stopAgents(name?: string): Promise<readonly string[]>;
  /** Opens one agent's conversation as a live feed, or undefined for an unknown name. */
  agentChat(name: string): Promise<ChatFeed | undefined>;
  /** The memory view, oldest first, as Pi sees it. */
  memoryView(): readonly ViewLine[];
  /** Opens line id+n into the two lines under it; n = 1 gives the message whole. Same text as the zoom tool. */
  zoom(id: number, n: number): string;
  /** Models to pick from, the current one included. */
  models(): Promise<readonly ModelChoice[]>;
  /**
   * Switches Pi and its agents to this model from their next request, and saves it as the default for later
   * launches that pass no --model. Rejects with a readable message when the model is unknown or has no credentials.
   */
  setModel(provider: string, id: string): Promise<void>;
  /** Turns coding tools (read, write, edit, bash) on or off for Pi and its agents, for this launch only. */
  setTools(enabled: boolean): Promise<void>;
}
