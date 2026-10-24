// One conversation as a ChatFeed: pi-durable's agent events folded into ChatItems.
import type { Context } from '@earendil-works/chord';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { watchEvents } from '@earendil-works/pi-durable';
import type {
  AgentEvent, AgentEventStream, AgentState, ConversationId, EntryRecord, Harness, MessageChange, SnapshotEvent,
  SubmissionRecord, ToolSlot,
} from '@earendil-works/pi-durable';
import { MESSAGE_KIND, REPORT_KIND } from '../agents/index.ts';
import { isRecord } from '../host/config.ts';
import type { ChatFeed, ChatImage, ChatItem } from './types.ts';

/** Items kept per feed: the newest ones. */
export const CAP = 200;

type Block = AssistantMessage['content'][number];
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
/** A block of the in-flight answer; tool arguments stay unparsed JSON while they stream. */
type LiveBlock = { kind: 'text' | 'thinking'; text: string } | { kind: 'tool'; id: string; name: string; args: unknown };
type Streaming = { key: string; blocks: (LiveBlock | undefined)[] };

/** What the status line reads from a conversation's events. */
export interface FeedState {
  readonly busy: boolean;
  readonly queued: number;
  readonly agent: AgentState;
}

const toolId = (callId: string): string => `tool:${callId}`;
const liveBlock = (block: Block): LiveBlock => block.type === 'toolCall'
  ? { kind: 'tool', id: block.id, name: block.name, args: block.arguments }
  : block.type === 'thinking' ? { kind: 'thinking', text: block.thinking } : { kind: 'text', text: block.text };

/** Text blocks joined; images are `imagesOf`'s. */
function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map(block => block.type === 'text' ? block.text : '').join('');
}

/** Image blocks as ChatImages, or undefined for none: an item without images has no `images` field. */
function imagesOf(content: Message['content']): readonly ChatImage[] | undefined {
  if (typeof content === 'string') return undefined;
  const images = content.flatMap(block => block.type === 'image' ? [{ mimeType: block.mimeType, data: block.data }] : []);
  return images.length ? images : undefined;
}

/** `item` with `images` when there are any. */
const withImages = <T extends object>(item: T, images: readonly ChatImage[] | undefined): T =>
  images === undefined ? item : { ...item, images };

/** `value` with `delta` appended to the string at `path` (a streamed tool argument); anything else unchanged. */
function appendAt(value: unknown, path: readonly (string | number)[], delta: string): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return typeof value === 'string' ? value + delta : value;
  if (Array.isArray(value) && typeof head === 'number') {
    const list: unknown[] = value, copy = [...list];
    copy[head] = appendAt(copy[head], rest, delta);
    return copy;
  }
  return isRecord(value) ? { ...value, [head]: appendAt(value[head], rest, delta) } : value;
}

const compact = (args: unknown): string => JSON.stringify(args) ?? '';

/** An agent input entry's sender and text: a report (`agents.report`) or a message (`agents.message`). */
function reportOf(entry: EntryRecord): { from: string; text: string } | undefined {
  const { data } = entry;
  if (!isRecord(data) || typeof data.text !== 'string') return undefined;
  const from = entry.kind === REPORT_KIND ? data.name : entry.kind === MESSAGE_KIND ? data.from : undefined;
  return typeof from === 'string' ? { from, text: data.text } : undefined;
}

/** A conversation's feed; also tracks its busy, queued, and agent state for the status line. */
export class ConversationFeed implements ChatFeed {
  private committed: ChatItem[] = [];
  private partial: Streaming | undefined;
  private view: readonly ChatItem[] = [];
  private live = 0;
  private dirty = false;
  private closing: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly stateListeners = new Set<(events: readonly AgentEvent[]) => void>();
  private current: FeedState = { busy: false, queued: 0, agent: {} };
  private readonly stream: AgentEventStream;

  private constructor(stream: AgentEventStream) {
    this.stream = stream;
    this.reset(stream.snapshot);
    this.flush();
  }

  /** Attach to `conversationId`'s events; the snapshot at attachment gives the history. */
  static async open(harness: Harness, conversationId: ConversationId, context: Context): Promise<ConversationFeed> {
    const feed = new ConversationFeed(await watchEvents(harness, conversationId, context));
    feed.stream.start(async (events) => { feed.apply(events); });
    return feed;
  }

  items(): readonly ChatItem[] { return this.view; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  state(): FeedState { return this.current; }

  /** Called after each batch of events, with the batch; for status refreshes. */
  onState(listener: (events: readonly AgentEvent[]) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  close(): Promise<void> {
    this.listeners.clear();
    this.stateListeners.clear();
    this.closing ??= this.stream.stop().then(() => undefined);
    return this.closing;
  }

  /** Fold one batch (one commit) into the items, then notify. */
  apply(events: readonly AgentEvent[]): void {
    events.forEach((event, at) => {
      // A message_start right before its message_end is a committed message that did not stream.
      if (event.type === 'message_start' && events[at + 1]?.type === 'message_end') return;
      this.event(event);
    });
    this.flush();
    for (const listener of this.stateListeners) call(() => listener(events));
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

  private reset(snapshot: SnapshotEvent): void {
    this.committed = [];
    this.partial = undefined;
    this.dirty = true;
    // Enough entries for CAP items; older ones would be trimmed anyway.
    for (const entry of snapshot.entries.slice(-2 * CAP)) this.entry(entry);
    const { generation } = snapshot;
    if (generation?.message) this.startPartial(generation.message);
    if (generation?.retry) this.retry(generation.attempt, generation.retry.at, generation.retry.error);
    for (const slot of snapshot.tools) this.slot(slot);
    this.setState({ busy: snapshot.run !== undefined, queued: snapshot.inbox.length, agent: snapshot.agent });
    if (!snapshot.run) this.settleTools();
  }

  private event(event: AgentEvent): void {
    switch (event.type) {
      case 'snapshot': return this.reset(event);
      case 'message_start':
        if (event.message.role === 'assistant') this.startPartial(event.message);
        return;
      case 'message_update': return this.update(event.changes);
      case 'message_end': return this.entry(event.entry);
      case 'tool_execution_start':
        if (event.parentToolCallId === undefined) this.patchTool(event.toolCallId, event.toolName, { args: compact(event.args), status: 'running' });
        return;
      case 'tool_execution_update': {
        const { output } = event;
        if (event.parentToolCallId !== undefined || !output) return;
        return this.patchTool(event.toolCallId, event.toolName, item => ({
          output: 'set' in output ? output.set : item.output.slice(output.trimStart ?? 0) + (output.append ?? ''),
        }));
      }
      case 'tool_execution_end':
        // With an entry, the result's message_end follows and finishes the item.
        if (event.parentToolCallId === undefined && !event.entry) {
          this.patchTool(event.toolCallId, event.toolName, item => ({ status: 'error', output: item.output || '(no result)' }));
        }
        return;
      case 'run_start': return this.setState({ busy: true });
      case 'run_end':
        this.setState({ busy: false });
        this.endPartial();
        return this.settleTools();
      case 'inbox_update': return this.setState({ queued: event.items.length });
      case 'agent_changed': return this.setState({ agent: event.agent });
      case 'submission': return this.submission(event.record);
      case 'auto_retry_start': return this.retry(event.attempt, event.at, event.errorMessage);
      case 'task_failed':
        return this.push({ kind: 'notice', id: `task:${event.taskId}`, text: `${event.kind} failed: ${event.message}`, level: 'error' });
      default: return;
    }
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
    const report = reportOf(entry);
    if (report) return this.push({ kind: 'report', id: `e${entry.id}`, ...report });
    (entry.model ?? []).forEach((message, m) => {
      const id = m === 0 ? `e${entry.id}` : `e${entry.id}.${m}`;
      if (message.role === 'user') this.push(withImages({ kind: 'user', id, text: textOf(message.content) }, imagesOf(message.content)));
      else if (message.role === 'toolResult') {
        this.patchTool(message.toolCallId, message.toolName, withImages({
          output: textOf(message.content), status: message.isError ? 'error' as const : 'done' as const,
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

  private startPartial(message: AssistantMessage): void {
    this.partial = { key: `live${++this.live}`, blocks: message.content.map(liveBlock) };
    this.dirty = true;
  }

  private update(changes: readonly MessageChange[]): void {
    const partial = this.partial;
    if (!partial) return;
    for (const change of changes) {
      if (change.type === 'message') { partial.blocks = change.message.content.map(liveBlock); continue; }
      const at = change.contentIndex, block = partial.blocks[at];
      switch (change.type) {
        case 'text_delta': case 'thinking_delta':
          if (block && block.kind !== 'tool') partial.blocks[at] = { ...block, text: block.text + change.delta };
          break;
        case 'toolcall_delta':
          if (block?.kind === 'tool') partial.blocks[at] = { ...block, args: appendAt(block.args, change.path, change.delta) };
          break;
        default: partial.blocks[at] = liveBlock(change.block);
      }
    }
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

  private slot(slot: ToolSlot): void {
    if (slot.status === 'done') return;
    this.patchTool(slot.callId, slot.name, { output: slot.output ?? '', status: 'running' });
  }

  /** No run is going: a tool still running never got its result. */
  private settleTools(): void {
    this.committed.forEach((item, at) => {
      if (item.kind !== 'tool' || item.status !== 'running') return;
      this.committed[at] = { ...item, status: 'error', output: item.output || '(no result)' };
      this.dirty = true;
    });
  }

  private retry(attempt: number, at: number, error: string): void {
    this.push({ kind: 'notice', id: `retry:${at}`, text: `Retrying (attempt ${attempt}): ${error}`, level: 'warn' });
  }

  private submission(record: SubmissionRecord): void {
    if (record.type !== 'input' || record.status !== 'unanswered') return;
    // A model error already shows as the failed answer's notice.
    if (record.reason === 'model_error') return;
    const text = record.reason !== 'aborted' ? `Not answered: ${record.reason}.`
      : record.entry === undefined ? 'Queued message withdrawn.' : 'Interrupted.';
    this.push({ kind: 'notice', id: `submission:${record.id}`, text, level: record.reason === 'aborted' ? 'info' : 'warn' });
  }
}

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
