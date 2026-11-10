// One conversation as a ChatFeed: pi-durable's conversation view (entries, `pi.live`, `pi.inbox`, `pi.agent`) folded
// into ChatItems.
import type { Context } from '@earendil-works/chord/context';
import type { JsonRepresentation } from '@earendil-works/chord/json';
import type { WatchCall, WatchHandle } from '@earendil-works/chord/watch';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { AgentDoc, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import type {
  AgentState, ConversationDocToken, ConversationId, ConversationView, EntryId, EntryRecord, Harness, JsonObject, LiveState,
  RunFailure, ToolSlot,
} from '@earendil-works/pi-durable';
import { agentInputOf, text } from '../agents/entries.ts';
import { fireName, scheduleFireOf } from '../schedule/entries.ts';
import { isRecord } from '../protocol/util.ts';
import type { ChatFeed, ChatItem } from '../protocol/session.ts';
import type { ChatImage } from '../protocol/images.ts';

/** Items kept per feed: the newest ones. */
export const CAP = 200;

type Block = AssistantMessage['content'][number];
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
/** A block of the in-flight answer; tool arguments stay unparsed JSON while they stream. */
type LiveBlock = { kind: 'text' | 'thinking'; text: string } | { kind: 'tool'; id: string; name: string; args: unknown };
type Streaming = { key: string; blocks: (LiveBlock | undefined)[] };

/** What the status line reads from a conversation's view. */
export interface FeedState {
  readonly busy: boolean;
  readonly queued: number;
  readonly agent: AgentState;
}

/** What one view revision changed, for status refreshes: `settled` when an entry was appended, a tool call ended, or a run started or ended. */
export interface FeedChange {
  readonly settled: boolean;
}

const toolId = (callId: string): string => `tool:${callId}`;
const liveBlock = (block: Block): LiveBlock => block.type === 'toolCall'
  ? { kind: 'tool', id: block.id, name: block.name, args: block.arguments }
  : block.type === 'thinking' ? { kind: 'thinking', text: block.thinking } : { kind: 'text', text: block.text };


/** Image blocks as ChatImages, or undefined for none: an item without images has no `images` field. */
function imagesOf(content: Message['content']): readonly ChatImage[] | undefined {
  if (typeof content === 'string') return undefined;
  const images = content.flatMap(block => block.type === 'image' ? [{ mimeType: block.mimeType, data: block.data }] : []);
  return images.length ? images : undefined;
}

/** `item` with `images` when there are any. */
const withImages = <T extends object>(item: T, images: readonly ChatImage[] | undefined): T =>
  images === undefined ? item : { ...item, images };

const compact = (args: unknown): string => JSON.stringify(args) ?? '';

/** Why a message went unanswered, by `pi.live.runFailure`'s reason; other reasons show as they are, with their detail. */
const UNANSWERED: Readonly<Record<string, string>> = { no_model: 'the model is not available; pick another model' };

/** Entries the window has that the chat does not show: compaction summaries sit in place now, after what they summarize. */
const HIDDEN: ReadonlySet<string> = new Set(['pi.compaction']);

/** Entries a feed's first view holds, enough for CAP items; the window keeps up to twice as many. */
const WINDOW = { min: 2 * CAP };

/** A built-in document of the view; the view holds each as stored, keyed by kind. */
const docOf = <T extends JsonObject>(view: ConversationView, token: ConversationDocToken<T>): Readonly<T> | undefined =>
  view.docs[token.definition.kind] as Readonly<T> | undefined;

/** An agent input entry's sender and text: a report (`agents.report`) or a message (`agents.message`). */

/** A conversation's feed; also tracks its busy, queued, and agent state for the status line. */
export class ConversationFeed implements ChatFeed {
  private committed: ChatItem[] = [];
  private partial: Streaming | undefined;
  private view: readonly ChatItem[] = [];
  private live = 0;
  private dirty = false;
  /** The newest entry folded in: a later view appends only what is newer. */
  private last: EntryId | undefined;
  /** The current run's `first` entry, to tell a new run from the one before when both arrive in one update. */
  private runFirst: EntryId | undefined;
  /** Run failures and compaction failures shown (or there at attachment): each shows once. */
  private readonly failures = new Set<string>();
  private closing: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly stateListeners = new Set<(change: FeedChange) => void>();
  private current: FeedState = { busy: false, queued: 0, agent: {} };
  private readonly watch: WatchHandle<ConversationView>;

  private constructor(watch: WatchHandle<ConversationView>) {
    this.watch = watch;
    // A failure the conversation already had when the feed attached is history the old view did not show either.
    const live = docOf(watch.value, LiveDoc);
    if (live?.runFailure) this.failures.add(runKey(live.runFailure));
    if (live?.compactionFailure) this.failures.add(`compaction:${live.compactionFailure.taskId}`);
    this.fold(watch.value);
    this.flush();
  }

  /** Attach to `conversationId`'s view; its first window gives the history. */
  static async open(harness: Harness, conversationId: ConversationId, context: Context): Promise<ConversationFeed> {
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) throw new Error(`No conversation ${conversationId}.`);
    const feed = new ConversationFeed(await conversation.watch(context, WINDOW));
    feed.watch.start(async (call: WatchCall<ConversationView>) => { if (call.kind === 'value') feed.apply(call.value); });
    return feed;
  }

  items(): readonly ChatItem[] { return this.view; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  state(): FeedState { return this.current; }

  /** Called after each view revision, with what it changed; for status refreshes. */
  onState(listener: (change: FeedChange) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  close(): Promise<void> {
    this.listeners.clear();
    this.stateListeners.clear();
    this.closing ??= this.watch.stop().then(() => undefined);
    return this.closing;
  }

  /** Fold one revision of the view (commits made while the last one was handled arrive folded) into the items, then notify. */
  apply(view: ConversationView): void {
    const change = this.fold(view);
    this.flush();
    for (const listener of this.stateListeners) call(() => listener(change));
  }

  private fold(view: ConversationView): FeedChange {
    const live = docOf(view, LiveDoc) ?? {};
    const wasBusy = this.current.busy, busy = live.run !== undefined;
    let settled = wasBusy !== busy;
    // New entries first: a committed answer takes the ids its partial had.
    for (const entry of view.entries) {
      if (this.last !== undefined && entry.id <= this.last) continue;
      this.last = entry.id;
      settled = true;
      if (!HIDDEN.has(entry.kind)) this.entry(entry);
    }
    // A run ended and the next started between two updates: the old partial ends before the new one streams.
    const first = live.run?.first;
    if (first !== undefined && this.runFirst !== undefined && first !== this.runFirst) this.endPartial();
    if (first !== undefined || !busy) this.runFirst = first;
    this.generation(live.generation);
    for (const slot of live.tools ?? []) if (this.slot(slot)) settled = true;
    if (live.runFailure) this.runFailure(live.runFailure);
    const failed = live.compactionFailure;
    if (failed && !this.failures.has(`compaction:${failed.taskId}`)) {
      this.failures.add(`compaction:${failed.taskId}`);
      this.push({ kind: 'notice', id: `compaction:${failed.taskId}`, text: `Compaction failed: ${failed.error}`, level: 'error' });
    }
    if (!busy) {
      this.endPartial();
      this.settleTools();
    }
    this.setState({ busy, queued: docOf(view, InboxDoc)?.items.length ?? 0, agent: docOf(view, AgentDoc) ?? {} });
    return { settled };
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.committed.length > CAP) this.committed.splice(0, this.committed.length - CAP);
    // A streaming block that did not change keeps its object: the TUI caches rendered lines per item object.
    const before = new Map(this.view.map(item => [item.id, item]));
    const live = this.partial ? this.blockItems(this.partial.key, this.partial.blocks, true) : [];
    this.view = [...this.committed, ...live.map(item => kept(before.get(item.id), item))];
    for (const listener of this.listeners) call(listener);
  }

  private setState(change: Partial<FeedState>): void {
    this.current = { ...this.current, ...change };
  }

  private push(item: ChatItem): void {
    const at = this.committed.findLastIndex(each => each.id === item.id);
    const known = this.committed[at];
    if (known && same(known, item)) return;
    if (at >= 0) this.committed[at] = item;
    else this.committed.push(item);
    this.dirty = true;
  }

  /** A committed entry's items. A streamed answer keeps the ids its partial had. */
  private entry(entry: EntryRecord): void {
    const input = agentInputOf(entry);
    if (input) return this.push({ kind: 'report', id: `e${entry.id}`, from: input.from, text: input.text });
    // A scheduled wake-up (ADR 0038) shows as a report too, from "Schedule #n": no new item kind for clients to learn.
    const fire = scheduleFireOf(entry);
    if (fire) return this.push({ kind: 'report', id: `e${entry.id}`, from: fireName(fire.id), text: fire.text });
    (entry.model ?? []).forEach((message, m) => {
      const id = m === 0 ? `e${entry.id}` : `e${entry.id}.${m}`;
      if (message.role === 'user') this.push(withImages({ kind: 'user', id, text: text(message.content) }, imagesOf(message.content)));
      else if (message.role === 'toolResult') {
        this.patchTool(message.toolCallId, message.toolName, withImages({
          output: text(message.content), status: message.isError ? 'error' as const : 'done' as const,
        }, imagesOf(message.content)));
      } else if (message.role === 'assistant') {
        const key = this.partial?.key ?? id;
        this.partial = undefined;
        for (const item of this.blockItems(key, message.content.map(liveBlock), false)) this.push(item);
        if (message.stopReason === 'error') {
          this.push({ kind: 'notice', id: `${key}.error`, text: message.errorMessage ?? 'The model failed.', level: 'error' });
        } else if (message.stopReason !== 'aborted') {
          // An answer with nothing to show would otherwise end the turn in silence.
          const replied = message.content.some(block => (block.type === 'text' && block.text.trim()) || block.type === 'toolCall');
          if (!replied) this.push({ kind: 'notice', id: `${key}.empty`, text: 'The model ended its turn without a reply.', level: 'warn' });
          else if (message.stopReason === 'length') {
            this.push({ kind: 'notice', id: `${key}.length`, text: 'The reply hit the model\'s output limit and was cut off.', level: 'warn' });
          }
        }
        this.dirty = true;
      }
    });
  }

  private blockItems(key: string, blocks: readonly (LiveBlock | undefined)[], streaming: boolean): ChatItem[] {
    const items: ChatItem[] = [];
    blocks.forEach((block, b) => {
      if (!block) return;
      if (block.kind === 'tool') {
        const id = block.id ? toolId(block.id) : `${key}.${b}`;
        const known = this.committed.findLast((each): each is ToolItem => each.kind === 'tool' && each.id === id);
        items.push(known ?? { kind: 'tool', id, name: block.name, args: compact(block.args), output: '', status: 'running' });
      } else if (block.text) {
        items.push(block.kind === 'text'
          ? { kind: 'assistant', id: `${key}.${b}`, text: block.text, streaming }
          : { kind: 'thinking', id: `${key}.${b}`, text: block.text, streaming });
      }
    });
    return items;
  }

  /** The in-flight answer (`pi.live.generation`): its streamed partial, and a retry's backoff. */
  private generation(generation: LiveState['generation']): void {
    if (generation?.retry) {
      const { at, error } = generation.retry;
      this.push({ kind: 'notice', id: `retry:${at}`, text: `Retrying (attempt ${generation.attempt}): ${error}`, level: 'warn' });
    }
    const message = generation?.message;
    if (!message) return;
    const blocks = partialContent(message).map(liveBlock);
    this.partial ??= { key: `live${++this.live}`, blocks };
    this.partial.blocks = blocks;
    this.dirty = true;
  }

  /** A partial the run left uncommitted: keep what was shown, no longer streaming. */
  private endPartial(): void {
    if (!this.partial) return;
    for (const item of this.blockItems(this.partial.key, this.partial.blocks, false)) this.push(item);
    this.partial = undefined;
    this.dirty = true;
  }

  private patchTool(callId: string, name: string, change: Partial<ToolItem> | ((item: ToolItem) => Partial<ToolItem>)): void {
    const id = toolId(callId);
    const item = this.committed.findLast((each): each is ToolItem => each.kind === 'tool' && each.id === id)
      ?? { kind: 'tool', id, name, args: '', output: '', status: 'running' };
    this.push({ ...item, ...(typeof change === 'function' ? change(item) : change) });
  }

  /**
   * One call of the current tool round: running with its output so far, or done. Done with a result entry, that entry
   * finishes the item; done without one (the tool task faulted or was orphaned), it fails. True when it ended here.
   */
  private slot(slot: ToolSlot): boolean {
    if (slot.status !== 'done') {
      this.patchTool(slot.callId, slot.name, { output: slot.output ?? '', status: 'running' });
      return false;
    }
    if (slot.entry !== undefined) return false;
    const item = this.committed.findLast((each): each is ToolItem => each.kind === 'tool' && each.id === toolId(slot.callId));
    if (item?.status !== 'running') return false;
    this.patchTool(slot.callId, slot.name, known => ({ status: 'error', output: known.output || '(no result)' }));
    return true;
  }

  /** No run is going: a tool still running never got its result. */
  private settleTools(): void {
    this.committed.forEach((item, at) => {
      if (item.kind !== 'tool' || item.status !== 'running') return;
      this.committed[at] = { ...item, status: 'error', output: item.output || '(no result)' };
      this.dirty = true;
    });
  }

  /** Why the newest run ended without an answer, once per run. */
  private runFailure(failure: RunFailure): void {
    const key = runKey(failure);
    if (this.failures.has(key)) return;
    this.failures.add(key);
    // A model error already shows as the failed answer's notice.
    if (failure.reason === 'model_error') return;
    const { reason, detail } = failure;
    const [text, level] = reason === 'aborted' ? ['Interrupted.', 'info' as const]
      : reason === 'faulted' ? [`The reply failed: ${detail ?? 'unknown error'}`, 'error' as const]
        : [`Not answered: ${UNANSWERED[reason] ?? (detail ? `${reason} (${detail})` : reason)}.`, 'warn' as const];
    this.push({ kind: 'notice', id: key, text, level });
  }
}

const runKey = (failure: RunFailure): string => `run:${failure.taskId}`;

/** The streamed partial's content blocks; the view holds the message as JSON. */
const partialContent = (message: JsonRepresentation<AssistantMessage>): AssistantMessage['content'] =>
  (message as AssistantMessage).content;

/** Whether two items show the same: every field is a primitive, or an `images` list compared image by image. */
function same(a: ChatItem, b: ChatItem): boolean {
  const left: Record<string, unknown> = a, right: Record<string, unknown> = b;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]
    || (key === 'images' && sameImages(left[key], right[key])));
}

function sameImages(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const x: readonly unknown[] = a, y: readonly unknown[] = b;
  return x.every((image, k) => {
    const other = y[k];
    return isRecord(image) && isRecord(other) && image.mimeType === other.mimeType && image.data === other.data;
  });
}

/** `item`, or the equal object shown before it. Items are never mutated: a change is a new object. */
const kept = (before: ChatItem | undefined, item: ChatItem): ChatItem => before && same(before, item) ? before : item;

/** A listener's failure must not stop the event stream. */
function call(listener: () => void): void {
  try { listener(); } catch { /* the UI's problem, not the feed's */ }
}
