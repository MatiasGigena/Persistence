// The host's state as the UI sees it (src/ui/types.ts): Pi's chat, status, memory view, and agents.
import type { AgentEvent, AgentState, ModelRef } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { listAgents, stopAgents } from '../agents/index.ts';
import { errorMessage, isThinkingLevel, updateSettings } from '../host/config.ts';
import type { Config } from '../host/config.ts';
import { start } from '../memory/view.ts';
import { modelChooser, thinkingLevels } from '../runtime/models.ts';
import type { Instance } from '../runtime/runtime.ts';
import { ConversationFeed } from './feed.ts';
import type { AgentStatus, ChatFeed, NoticeLevel, SessionStatus, UiSession, ViewLine } from './types.ts';

/**
 * The launch choices the status line falls back on until Pi's stored agent says otherwise; `setModel()` saves to
 * `settingsPath` when given, and names `authFile` when credentials are missing.
 */
export type UiSessionConfig = Pick<Config, 'model' | 'thinkingLevel' | 'allowTools'> & Partial<Pick<Config, 'settingsPath' | 'authFile'>>;

/** A UiSession the host owns: `close()` stops its feeds and timer, leaving the Instance open. */
export interface UiSessionHandle extends UiSession {
  /** Sends a host notice to every `onNotice` listener (the host's console warnings while a client shows the chat). */
  notify(text: string, level: NoticeLevel): void;
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
 * open on demand. Nothing here writes except `send()`, `abort()`, `setModel()`, `setTools()` and `setThinkingLevel()`.
 */
export async function createUiSession(
  instance: Instance, config: UiSessionConfig, { refreshMs = 1500 }: UiSessionOptions = {},
): Promise<UiSessionHandle> {
  const { harness, root, context, memory } = instance;
  const chat = await ConversationFeed.open(harness, root.id, context);
  const feeds = new Set<ChatFeed>();
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(text: string, level: NoticeLevel) => void>();
  let agents: readonly AgentStatus[] = [];
  const chooser = modelChooser(instance.models, { authFile: config.authFile });
  // This session's switches, shown before Pi's stored agent reports them.
  let chosenModel: ModelRef | undefined;
  let chosenTools: boolean | undefined;
  let chosenThinking: string | undefined;
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
      thinkingLevel: chosenThinking ?? agent.thinkingLevel ?? config.thinkingLevel,
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
      // Clients see the contract's shape only: no conversation IDs.
      .then(list => { agents = list.map(({ name, role, parent, busy }) => ({ name, role, parent, busy })); },
        () => { /* the next poll retries */ })
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
    async send(text, requestId, steer, target) {
      // Standalone keeps follow-up/steering; routed admission pins the target and explicitly rejects busy runs.
      await instance.submit(text, requestId, target, steer);
    },
    async abort() {
      // Pi's current run only: queued inputs are withdrawn; agents' background deliveries keep going.
      await root.abort(context);
    },
    stopAgents: name => stopAgents(harness, context, name),
    async agentChat(name) {
      const found = (await listAgents(harness, context)).find(agent => agent.name.toLowerCase() === name.toLowerCase());
      if (!found || closed) return undefined;
      const feed = await ConversationFeed.open(harness, found.conversationId, context);
      const tracked: ChatFeed = { items: () => feed.items(), subscribe: listener => feed.subscribe(listener),
        close: () => { feeds.delete(tracked); return feed.close(); } };
      feeds.add(tracked);
      return tracked;
    },
    memoryView: () => Promise.resolve(memoryLines(instance)),
    async zoom(id, n) {
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
        try { await updateSettings(config.settingsPath, { model }); } catch (error) {
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
    thinkingLevels: () => Promise.resolve(thinkingLevels(instance.models, currentModel())),
    setThinkingLevel(level) {
      return serially(async () => {
        const model = currentModel();
        const levels = thinkingLevels(instance.models, model);
        if (!isThinkingLevel(level) || !levels.includes(level)) {
          throw new Error(`${model.provider}/${model.modelId} takes ${levels.join(', ')}; not ${level}.`);
        }
        await instance.setThinkingLevel(level);
        chosenThinking = level;
        refresh();
        if (!config.settingsPath) return;
        try { await updateSettings(config.settingsPath, { thinkingLevel: level }); } catch (error) {
          throw new Error(`Effort set to ${level}, but saving it as the default failed: ${errorMessage(error)}`);
        }
      });
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => { noticeListeners.delete(listener); };
    },
    notify(text, level) {
      if (closed) return;
      for (const listener of noticeListeners) {
        try { listener(text, level); } catch { /* a listener's failure must not stop the others */ }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      listeners.clear();
      noticeListeners.clear();
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
