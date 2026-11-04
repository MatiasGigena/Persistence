// The host's state as the UI sees it (src/protocol/session.ts): Pi's chat, status, memory view, and agents.
import { InboxDoc } from '@earendil-works/pi-durable';
import type { AgentState, ModelRef } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { archiveAgents, listAgents, restoreAgent, stopAgents } from '../agents/index.ts';
import { updateSettings } from './config.ts';
import { isThinkingLevel } from '../runtime/thinking.ts';
import { errorMessage } from '../protocol/util.ts';
import type { Config } from './config.ts';
import { start } from '../memory/view.ts';
import { imagesProblem, modelChooser, thinkingLevels } from '../runtime/models.ts';
import type { Instance } from '../runtime/runtime.ts';
import { ConversationFeed } from './feed.ts';
import type { AgentStatus, ChatFeed, NoticeLevel, SessionStatus, UiSession, ViewLine } from '../protocol/session.ts';
import { NotFound, Unavailable } from '../protocol/errors.ts';

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

/**
 * Open the UI's view of `instance`: a live feed of Pi's conversation, its status, and the memory view. Agents' feeds
 * open on demand. Nothing here writes except `send()`, `abort()`, the agent controls, `setModel()`, `setTools()` and
 * `setThinkingLevel()`.
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
  /**
   * Whether `requestId` was already admitted to Pi's conversation: a client retrying after a lost acknowledgement. Its
   * images went in with the first admission, so a model switched since then must not refuse the retry, which would
   * make the client restore (and later resend) a message Pi already has.
   */
  const admitted = async (requestId: string | undefined): Promise<boolean> => requestId !== undefined
    && await harness.commit(tx => tx.submissionByRequest(root.id, requestId), context) !== undefined;
  /** Whether Pi's inbox holds an unconsumed input with an image. */
  const queuedImages = async (): Promise<boolean> => {
    const inbox = await harness.snapshot(InboxDoc, root.id, context);
    return (inbox?.items ?? []).some(item => item.mode !== 'write' && Array.isArray(item.content)
      && item.content.some(part => part.type === 'image'));
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
    reading = listAgents(harness, context, { includeArchived: true })
      // Clients see the contract's shape only: no conversation IDs.
      .then(list => {
        agents = list.map(({ name, role, parent, busy, standing, archivedAt }) => ({ name, role, parent, busy,
          ...standing ? { standing: true as const } : {}, ...archivedAt === undefined ? {} : { archivedAt } }));
      },
        () => { /* the next poll retries */ })
      .finally(() => {
        reading = undefined;
        refresh();
        if (again) { again = false; refreshAgents(); }
      });
  }

  /** A fresh registry read, settled: the status shows the change once this resolves. */
  async function agentsRead(): Promise<void> {
    while (reading) await reading;
    refreshAgents();
    await reading;
  }

  chat.onState(({ settled }) => {
    refresh();
    // An entry, a finished tool call, or a run's start or end may have changed the memory log or the agent registry.
    if (settled) refreshAgents();
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
    send(text, options = {}) {
      // Through the switching queue: while setModel() configures Pi and syncs its agents, chosenModel is not yet the
      // model Pi uses, so the image check and the admission wait for the switch to finish.
      return serially(async () => {
        if (options.images?.length && !await admitted(options.requestId)) {
          const problem = imagesProblem(instance.models, currentModel());
          if (problem) throw new Error(problem);
        }
        // Standalone keeps follow-up/steering; routed admission pins the target and explicitly rejects busy runs. An
        // admitted request ID returns its first submission (dedup), after the route check.
        await instance.submit(text, options);
      });
    },
    async abort() {
      // Pi's current run only: queued inputs are withdrawn; agents' background deliveries keep going.
      await root.abort(context);
    },
    stopAgents: name => stopAgents(harness, context, name),
    async archiveAgents(target) {
      const names = await archiveAgents(harness, context, target, Date.now());
      await agentsRead();
      return names;
    },
    async restoreAgent(name) {
      const names = await restoreAgent(harness, context, name);
      await agentsRead();
      return names;
    },
    async agentChat(name) {
      // Archived agents too: their conversation stays readable until it is deleted.
      const found = (await listAgents(harness, context, { includeArchived: true })).find(agent => agent.name.toLowerCase() === name.toLowerCase());
      if (!found || closed) return undefined;
      const feed = await ConversationFeed.open(harness, found.conversationId, context);
      const tracked: ChatFeed = { items: () => feed.items(), subscribe: listener => feed.subscribe(listener),
        close: () => { feeds.delete(tracked); return feed.close(); } };
      feeds.add(tracked);
      return tracked;
    },
    memoryView: () => Promise.resolve(memoryLines(instance)),
    async zoom(id, n) {
      if (!memory) throw new Unavailable('Memory is not open (inspection only).');
      // Memory.zoom throws only for a line or message the log does not have.
      try { return memory.zoom(id, n); } catch (error) { throw new NotFound(errorMessage(error), { cause: error }); }
    },
    models: () => chooser.list(currentModel()),
    setModel(provider, id) {
      return serially(async () => {
        const model = { provider, modelId: id };
        // Unrouted input is acknowledged when queued; a switch to a model without images before Pi reads it would
        // have its images downgraded to a text note, so refuse the switch until queued images are consumed.
        // Credentials can take seconds; inspect the inbox afterwards, including input admitted by other callers.
        await chooser.check(model);
        if (imagesProblem(instance.models, model) && await queuedImages()) {
          throw new Error(`A queued message has images ${provider}/${id} cannot take; switch after Pi reads it, or stop Pi first.`);
        }
        await instance.setModel(model);
        chosenModel = model;
        refresh();
        if (!config.settingsPath) return;
        try { await updateSettings(config.settingsPath, { model }); } catch (error) {
          throw new Error(`Switched to ${provider}/${id}, but saving it as the default failed: ${errorMessage(error)}`, { cause: error });
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
          // A model that does not reason takes only `off`.
          const takes = levels.some(each => each !== 'off') ? `takes ${levels.join(', ')}` : 'has no reasoning effort to set';
          throw new Error(`${model.provider}/${model.modelId} ${takes}; not ${level}.`);
        }
        await instance.setThinkingLevel(level);
        chosenThinking = level;
        refresh();
        if (!config.settingsPath) return;
        try { await updateSettings(config.settingsPath, { thinkingLevel: level }); } catch (error) {
          throw new Error(`Effort set to ${level}, but saving it as the default failed: ${errorMessage(error)}`, { cause: error });
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
