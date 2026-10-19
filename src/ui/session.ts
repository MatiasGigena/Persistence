// The host's state as the UI sees it (src/ui/types.ts): Pi's chat, status, memory view, and agents.
import type { AgentEvent, AgentState, ModelRef } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { listAgents } from '../agents/index.ts';
import type { AgentInfo } from '../agents/index.ts';
import { errorMessage, writeSettings } from '../host/config.ts';
import type { Config } from '../host/config.ts';
import { start } from '../memory/view.ts';
import { modelChooser } from '../runtime/models.ts';
import type { Instance } from '../runtime/runtime.ts';
import { ConversationFeed } from './feed.ts';
import type { ChatFeed, SessionStatus, UiSession, ViewLine } from './types.ts';

/**
 * The launch choices the status line falls back on until Pi's stored agent says otherwise; `setModel()` saves to
 * `settingsPath` when given, and names `authFile` when credentials are missing.
 */
export type UiSessionConfig = Pick<Config, 'model' | 'thinkingLevel' | 'allowTools'> & Partial<Pick<Config, 'settingsPath' | 'authFile'>>;

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
 * open on demand. Nothing here writes except `send()`, `abort()`, `setModel()` and `setTools()`.
 */
export async function createUiSession(
  instance: Instance, config: UiSessionConfig, { refreshMs = 1500 }: UiSessionOptions = {},
): Promise<UiSessionHandle> {
  const { harness, root, context, memory } = instance;
  const chat = await ConversationFeed.open(harness, root.id, context);
  const feeds = new Set<ChatFeed>();
  const listeners = new Set<() => void>();
  let agents: readonly AgentInfo[] = [];
  const chooser = modelChooser(instance.models, { authFile: config.authFile });
  // This session's switches, shown before Pi's stored agent reports them.
  let chosenModel: ModelRef | undefined;
  let chosenTools: boolean | undefined;
  // One switch at a time: each configures Pi, then re-derives the agents.
  let switching: Promise<unknown> = Promise.resolve();
  const serially = (change: () => Promise<void>): Promise<void> => {
    const next = switching.then(change);
    switching = next.catch(() => {});
    return next;
  };
  const currentModel = (): ModelRef => chosenModel ?? chat.state().agent.model ?? config.model;
  let current = compute();
  let shown = JSON.stringify(current);
  let closed = false;

  function compute(): SessionStatus {
    const { busy, queued, agent } = chat.state();
    const model = currentModel();
    return {
      model: `${model.provider}/${model.modelId}`,
      thinkingLevel: agent.thinkingLevel ?? config.thinkingLevel,
      toolsEnabled: chosenTools ?? toolsEnabled(agent, config.allowTools),
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
    models: () => chooser.list(currentModel()),
    setModel(provider, id) {
      return serially(async () => {
        const model = { provider, modelId: id };
        await chooser.check(model);
        await instance.setModel(model);
        chosenModel = model;
        refresh();
        if (!config.settingsPath) return;
        try { writeSettings(config.settingsPath, { model }); } catch (error) {
          throw new Error(`Switched to ${provider}/${id}, but saving it as the default failed: ${errorMessage(error)}`);
        }
      });
    },
    setTools(enabled) {
      return serially(async () => {
        await instance.setTools(enabled);
        chosenTools = enabled;
        refresh();
      });
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
