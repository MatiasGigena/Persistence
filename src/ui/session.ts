// The host's state as the UI sees it (src/ui/types.ts): Pi's chat, status, memory view, and agents.
import type { AgentEvent, AgentState } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { listAgents } from '../agents/index.ts';
import type { AgentInfo } from '../agents/index.ts';
import type { Config } from '../host/config.ts';
import { start } from '../memory/view.ts';
import type { Instance } from '../runtime/runtime.ts';
import { ConversationFeed } from './feed.ts';
import type { ChatFeed, SessionStatus, UiSession, ViewLine } from './types.ts';

/** The launch choices the status line falls back on until Pi's stored agent says otherwise. */
export type UiSessionConfig = Pick<Config, 'model' | 'thinkingLevel' | 'allowTools'>;

/** A UiSession the host owns: `close()` stops its feeds and timer, leaving the Instance open. */
export interface UiSessionHandle extends UiSession {
  close(): Promise<void>;
}

/** Options of `createUiSession()`. */
export interface UiSessionOptions {
  /** How often memory and agents are polled; they also change outside Pi's events. Default 1500 ms. */
  readonly refreshMs?: number;
}

const CODING_TOOLS: ReadonlySet<string> = new Set((CodingTools.tools ?? []).map(tool => tool.name));
// Events after which the memory log or the agent registry may have changed.
const REFRESHING: ReadonlySet<AgentEvent['type']> = new Set(['message_end', 'tool_execution_end', 'run_start', 'run_end']);

/**
 * Open the UI's view of `instance`: a live feed of Pi's conversation, its status, and the memory view. Agents' feeds
 * open on demand. Nothing here writes except `send()` and `abort()`.
 */
export async function createUiSession(
  instance: Instance, config: UiSessionConfig, { refreshMs = 1500 }: UiSessionOptions = {},
): Promise<UiSessionHandle> {
  const { harness, root, context, memory } = instance;
  const chat = await ConversationFeed.open(harness, root.id, context);
  const feeds = new Set<ChatFeed>();
  const listeners = new Set<() => void>();
  let agents: readonly AgentInfo[] = [];
  let current = compute();
  let shown = JSON.stringify(current);
  let closed = false;

  function compute(): SessionStatus {
    const { busy, queued, agent } = chat.state();
    const model = agent.model ?? config.model;
    return {
      model: `${model.provider}/${model.modelId}`,
      thinkingLevel: agent.thinkingLevel ?? config.thinkingLevel,
      toolsEnabled: toolsEnabled(agent, config.allowTools),
      busy,
      queued,
      memory: memory?.status(),
      agents,
    };
  }

  /** Recompute the status; notify only when it changed. */
  function refresh(): void {
    if (closed) return;
    const next = compute();
    const json = JSON.stringify(next);
    if (json === shown) return;
    current = next;
    shown = json;
    for (const listener of listeners) {
      try { listener(); } catch { /* a listener's failure must not stop the others */ }
    }
  }

  // One registry read at a time; a request during one reruns it once it ends.
  let reading: Promise<void> | undefined;
  let again = false;
  function refreshAgents(): void {
    if (closed) return;
    if (reading) { again = true; return; }
    reading = listAgents(harness, context)
      .then(list => { agents = list; }, () => { /* the next poll retries */ })
      .finally(() => {
        reading = undefined;
        refresh();
        if (again) { again = false; refreshAgents(); }
      });
  }

  chat.onState(events => {
    refresh();
    if (events.some(event => REFRESHING.has(event.type))) refreshAgents();
  });
  const timer = setInterval(() => { refresh(); refreshAgents(); }, refreshMs);
  timer.unref();
  refreshAgents();
  await reading;

  return {
    chat,
    status: () => current,
    onStatus(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async send(text) {
      // Admitted durably, not awaited: the feed shows the answer. A busy Pi gets it as a follow-up.
      await root.submit({ type: 'input', content: text }, context);
    },
    async abort() {
      // Pi's current run only: queued inputs are withdrawn; agents' background deliveries keep going.
      await root.abort(context);
    },
    async agentChat(name) {
      const found = (await listAgents(harness, context)).find(agent => agent.name.toLowerCase() === name.toLowerCase());
      if (!found || closed) return undefined;
      const feed = await ConversationFeed.open(harness, found.conversationId, context);
      const tracked: ChatFeed = { items: () => feed.items(), subscribe: listener => feed.subscribe(listener),
        close: () => { feeds.delete(tracked); return feed.close(); } };
      feeds.add(tracked);
      return tracked;
    },
    memoryView: () => memoryLines(instance),
    zoom(id, n) {
      if (!memory) throw new Error('Memory is not open (inspection only).');
      return memory.zoom(id, n);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      listeners.clear();
      await Promise.all([chat.close(), ...[...feeds].map(feed => feed.close())]);
      await reading;
    },
  };
}

/** Whether the coding tools are on: Pi's stored tool list decides; without one, this launch's flag. */
function toolsEnabled(agent: AgentState, allowTools: boolean): boolean {
  return Array.isArray(agent.tools) ? agent.tools.some(name => CODING_TOOLS.has(name)) : allowTools;
}

/** The memory view as Pi sees it, one line per tree node: `id+n|text`. */
export function memoryLines({ memory }: Pick<Instance, 'memory'>): ViewLine[] {
  if (!memory) return [];
  return memory.view.parts.map(p => {
    const line = memory.renderLine(p);
    return { id: start(p), n: 2 ** p.l, text: line.slice(line.indexOf('|') + 1) };
  });
}
