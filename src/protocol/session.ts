// The session contract: what the host's state (src/session/session.ts) offers its clients, the terminal UI (src/ui/tui/)
// and, over the wire protocol, the attached TUI and the web app. The session knows pi-durable, memory and agents;
// clients know only these types. Type-only, like the rest of src/protocol/ free of Node and DOM imports, so the browser
// type-checks against it; the wire messages (messages.ts) are built from these items.
import type { ChatImage } from './images.ts';
import type { MachineTarget } from './machines.ts';

/** One block of a conversation, in order. Streaming blocks are updated in place by `id`. */
export type ChatItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly images?: readonly ChatImage[] }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: 'thinking'; readonly id: string; readonly text: string; readonly streaming: boolean }
  | {
    readonly kind: 'tool'; readonly id: string; readonly name: string;
    /** Arguments as compact JSON, possibly partial while streaming. */
    readonly args: string;
    readonly output: string;
    readonly status: 'running' | 'done' | 'error';
    /** Images of the result: what the tool returned (read, browser_screenshot) or showed the user (show_image). */
    readonly images?: readonly ChatImage[];
  }
  /** An agent's report or message, "[Name] text", reaching this conversation. */
  | { readonly kind: 'report'; readonly id: string; readonly from: string; readonly text: string }
  /** Host notices: errors, retries, "work resumed", and so on. */
  | { readonly kind: 'notice'; readonly id: string; readonly text: string; readonly level: NoticeLevel };

/** One agent, as clients see it (src/agents' AgentInfo without its conversation ID). */
export interface AgentStatus {
  readonly name: string;
  readonly role: 'main' | 'sub';
  /** "Pi", or the main agent that spawned this sub agent. */
  readonly parent: string;
  readonly busy: boolean;
  /** A standing agent (ADR 0027): never archived. Absent for ad-hoc agents. */
  readonly standing?: true;
  /** When it was archived (milliseconds since the epoch); absent while active. Deleted a day later (ADR 0034). */
  readonly archivedAt?: number;
}

/** One scheduled wake-up (ADR 0038), as clients see it. */
export interface ScheduleStatus {
  readonly id: number;
  /** The message Pi left itself, on one line, cut to a preview. */
  readonly text: string;
  /** When it next fires, milliseconds since the epoch. */
  readonly at: number;
  /** A repeating schedule's cron expression, in the host's local time; absent on a one-off. */
  readonly cron?: string;
}

/** What to archive: one agent by name, or every ad-hoc main agent (not the standing ones). */
export type ArchiveTarget = { readonly name: string } | { readonly adhoc: true };

/** The memory's counters, as src/memory's `Memory.status()` reports them. */
export interface MemoryStats {
  /** Messages in the log. */
  readonly messages: number;
  /** Messages not yet summarized into a leaf. */
  readonly unsummarized: number;
  /** Compaction calls in flight. */
  readonly active: number;
  /** Compactions that failed and wait for a retry. */
  readonly failed: number;
  readonly lastError: string | undefined;
  readonly viewBytes: number;
  readonly viewLines: number;
}

/** Notice levels: host warnings and chat notices alike. */
export type NoticeLevel = 'info' | 'warn' | 'error';

/** Everything the footer and panels show besides the chat. */
export interface SessionStatus {
  /** "provider/modelId". */
  readonly model: string;
  readonly thinkingLevel: string;
  readonly toolsEnabled: boolean;
  /** Destination of new tool-bearing requests from this client, when remotely attached. */
  readonly machine?: MachineTarget;
  /** A run is working on Pi's conversation. */
  readonly busy: boolean;
  /** Inputs queued behind the running one. */
  readonly queued: number;
  /** Undefined while the memory is not open (inspection only). */
  readonly memory: MemoryStats | undefined;
  /** Every agent, archived ones included (with `archivedAt`): UIs list those apart and leave them out of counts. */
  readonly agents: readonly AgentStatus[];
  /** Pi's scheduled wake-ups, soonest first; absent from a server older than ADR 0038, and then shown as none. */
  readonly schedules?: readonly ScheduleStatus[];
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

/** Immutable execution destination; machineId "server" is reserved for the host. */
/** What a send carries besides its text; every field is optional, and the same object crosses every layer. */
export interface SendOptions {
  /** A client's id for the send: a repeat with the same id is admitted once. */
  readonly requestId?: string;
  /** Deliver to a busy Pi between its steps, instead of after its run. */
  readonly steer?: boolean;
  /** The machine and folder its tools run in; the server's own when omitted. */
  readonly target?: MachineTarget;
  /** Images that go to the model with the text. */
  readonly images?: readonly ChatImage[];
}

/** The shared chat contract. Every method may reject; none waits for a model answer. */
export interface UiSession {
  /** Pi's conversation. */
  readonly chat: ChatFeed;
  status(): SessionStatus;
  /** Called after any change to `status()`. Returns an unsubscribe function. */
  onStatus(listener: () => void): () => void;
  /**
   * Sends text to Pi: starts a run, or follows up the running one; with `steer`, a busy Pi gets it between its steps
   * instead of after its run. With `requestId`, a repeat of the same id is admitted once (pi-durable's submission
   * dedup), so a client may resend after losing the answer to a reconnect. `images` go to the model with the text;
   * the text may then be empty. Rejects when Pi's model takes no images, rather than dropping them, and, on a server
   * that routes tools to machines, while Pi is busy with a run on another destination than this message's.
   */
  send(text: string, options?: SendOptions): Promise<void>;
  /** Interrupts Pi's running work (Esc). Durable work stays resumable. */
  abort(): Promise<void>;
  /**
   * Stops one agent and its sub agents, or every agent when `name` is omitted; Pi is not touched.
   * Resolves with the names stopped, sub agents first; rejects with a not-found refusal for an unknown name.
   */
  stopAgents(name?: string): Promise<readonly string[]>;
  /**
   * Archives one agent (with a main agent's sub agents), or every ad-hoc main agent: their work stops, and they are
   * deleted a day later unless restored. Resolves with the names archived; an agent already archived keeps its time
   * and is among them. Rejects with a readable refusal for a standing agent or an unknown name (on the host an
   * unknown name is NotFound; over the wire it is the not_found code).
   */
  archiveAgents(target: ArchiveTarget): Promise<readonly string[]>;
  /** Restores an archived agent (with a main agent's sub agents). Resolves with the names restored; rejects readably. */
  restoreAgent(name: string): Promise<readonly string[]>;
  /** Cancels schedule `id`, so it never fires again. Rejects with NotFound for an unknown id. */
  cancelSchedule(id: number): Promise<void>;
  /** Opens one agent's conversation as a live feed, or undefined for an unknown name. */
  agentChat(name: string): Promise<ChatFeed | undefined>;
  /** The memory view, oldest first, as Pi sees it; empty while the memory is not open. */
  memoryView(): Promise<readonly ViewLine[]>;
  /**
   * Opens line id+n into the two lines under it; n = 1 gives the message whole. Same text as the zoom tool.
   * Rejects with a readable message for an unknown line, or while the memory is not open.
   */
  zoom(id: number, n: number): Promise<string>;
  /** Models to pick from, the current one included. */
  models(): Promise<readonly ModelChoice[]>;
  /**
   * Switches Pi and its agents to this model from their next request, and saves it as the default for later
   * launches that pass no --model. Rejects with a readable message when the model is unknown or has no credentials.
   */
  setModel(provider: string, id: string): Promise<void>;
  /** Turns coding tools (read, write, edit, bash) on or off for Pi and its agents, for this launch only. */
  setTools(enabled: boolean): Promise<void>;
  /** The reasoning efforts (thinking levels) the current model takes, lowest first. */
  thinkingLevels(): Promise<readonly string[]>;
  /**
   * Sets Pi's and its agents' reasoning effort from their next request, and saves it as the default for later
   * launches that pass no --thinking. Rejects with a readable message for a level the current model does not take.
   */
  setThinkingLevel(level: string): Promise<void>;
  /**
   * Host notices that are not chat items: warnings the host logs while a client shows the chat, tool switches made
   * by another client, and so on. Each listener gets each notice once; clients show them in the chat.
   * Returns an unsubscribe function.
   */
  onNotice(listener: (text: string, level: NoticeLevel) => void): () => void;
}

/** The state of an attached TUI's link to the server: up, down and retrying, or closed for good. */
export type LinkState = 'ready' | 'reconnecting' | 'closed';

/** An attached TUI's link to the server (src/client/), as the TUI sees it. */
export interface AttachedLink {
  state(): LinkState;
  /** Called after any change to `state()`. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}
