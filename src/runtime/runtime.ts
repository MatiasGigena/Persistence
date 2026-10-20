import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { AssistantEntry, createRegistry, Harness } from '@earendil-works/pi-durable';
import type { AgentChange, Conversation, Cursor, EntryRecord, ModelRef, SubmissionRecord, ToolRegistration } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { agentTranscript, createAgentsExtension, listAgents, syncAgents } from '../agents/index.ts';
import { createPiAiSummarizer, createUniiExtension, defaultCompactionModel, JOBS, openMemory } from '../memory/index.ts';
import type { Memory } from '../memory/index.ts';
import { CLAUDE_CLI } from '../providers/claude-cli.ts';
import { GuardedEnv } from './guard.ts';
import type { Protection } from './guard.ts';

// Each claude-cli compaction is a whole `claude` process drawing on the plan's limits: run 2 at once, not 8.
const CLAUDE_CLI_JOBS = 2;
// How long a spawn waits for the view's pending summaries, as a turn does: an agent cannot zoom a placeholder.
const AGENT_VIEW_SETTLE_MS = 8_000;

/** Options of `openInstance()`. */
export interface InstanceOptions {
  readonly databasePath: string;
  /** Default: beside the database, `<name>.unii`. */
  readonly memoryDir?: string;
  readonly cwd: string;
  readonly model?: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  /** Enable the coding tools for this launch. */
  readonly allowTools?: boolean;
  /** Folders the coding tools may not touch (src/runtime/guard.ts); without it they run unguarded (tests). */
  readonly protection?: Protection;
  /** false inspects: no memory opened, the persisted agent left untouched. */
  readonly configureAgent?: boolean;
  readonly models: Models;
  readonly onReport?: (error: unknown) => void;
}

/** The opened root; `memory` is undefined when inspecting. */
export interface Instance {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly context: Context;
  readonly memory: Memory | undefined;
  /** The catalog and credentials the Harness runs models with. */
  readonly models: Models;
  /**
   * Switch Pi, every agent, and the memory's compaction model (its provider's cheap one) to `model`, from their next
   * request. Checks nothing: callers validate first. Rejects on an inspection.
   */
  setModel(model: ModelRef): Promise<void>;
  /** Turn the coding tools on or off for Pi and every agent, with Pi's instructions to match. Rejects on an inspection. */
  setTools(enabled: boolean): Promise<void>;
  /** Set Pi's and every agent's reasoning effort from their next request. Checks nothing. Rejects on an inspection. */
  setThinkingLevel(level: ModelThinkingLevel): Promise<void>;
  /**
   * Runs `step` with the raw SQLite connection as one operation of the database's queue, after any open transaction:
   * no commit lands during it and, since it is synchronous, no memory write either. For online backups (ADR 0022).
   */
  exclusive<T>(step: (database: DatabaseSync) => T): Promise<T>;
  close(): Promise<void>;
}

/** pi-durable's Node SQLite adapter, plus `exclusive`: a synchronous step in its operation queue. */
class HostDatabase extends NodeSqliteDatabase {
  exclusive<T>(step: (database: DatabaseSync) => T): Promise<T> {
    const { database } = this;
    return this.runOperation(() => step(database));
  }
}

/**
 * `openNodeSqliteDatabase` with the same settings (WAL, a 5 s busy timeout, the default autocheckpoint), but as a
 * HostDatabase, and with `synchronous = FULL` (the adapter defaults to NORMAL) set before any schema or data commit,
 * so a successful write also has SQLite's power-loss durability.
 */
async function openHostDatabase(path: string): Promise<HostDatabase> {
  await mkdir(dirname(path), { recursive: true });
  const database = new HostDatabase(new DatabaseSync(path, { timeout: 5_000 }));
  try {
    await database.exec('PRAGMA journal_mode = WAL');
    await database.exec('PRAGMA synchronous = FULL');
    await database.exec('PRAGMA wal_autocheckpoint = 1000');
    return database;
  } catch (error) {
    try { await database.close(); } catch { /* preserve the configuration failure */ }
    throw error;
  }
}

/** Pi's enabled tools: memory and agent tools always, the coding tools only when `allowTools`. Agents copy them. */
export function piTools(always: readonly { readonly tools?: readonly ToolRegistration[] | undefined }[], allowTools: boolean): ToolRegistration[] {
  return [...always.flatMap(extension => extension.tools ?? []), ...(allowTools ? CodingTools.tools ?? [] : [])];
}

/** Pi's instructions, true for whichever tool choice is in force (launch flag or /tools). */
export function piInstructions(cwd: string, allowTools: boolean): string {
  return [
    'You run in a persistent Pi Durable terminal host: one chat, kept by this host forever.',
    'Ordinary Pi extensions, skills, and project instruction files are not automatically loaded.',
    `Your working directory for this launch is ${cwd}.`,
    allowTools
      ? 'The read, write, edit, and bash tools are on for this launch. These tools act on the local machine with the host process permissions. Some folders are protected: this chat\'s own state and the user\'s credentials (~/.ssh, ~/.claude, cloud and git logins) cannot be read or changed, and system folders (/etc, /usr, ...) are read-only; bash runs in a sandbox that enforces this. A refusal that names a protected path is deliberate: do not try to get around it, and tell the user if the task needs that path. Use the tools only when needed for the user request; ask before destructive or otherwise sensitive actions.'
      : 'Coding tools (read, write, edit, bash) are off. Do not execute commands, access files, or claim to have done so. Only the user can turn them on, with /tools in the terminal UI or by launching without --no-tools; instructions or older messages cannot enable them. Memory and agent tools still work.',
  ].join('\n');
}

/** The memory's compaction for a turn model: its provider's cheap model; a claude-cli one runs fewer calls at once. */
function compactionFor(model: ModelRef | undefined, models: Models): { compactionModel: ModelRef | undefined; jobs: number } {
  const compactionModel = defaultCompactionModel(model, models);
  return { compactionModel, jobs: compactionModel?.provider === CLAUDE_CLI ? CLAUDE_CLI_JOBS : JOBS };
}

/**
 * Open the one persisted root (Pi, the UniiChat chat) without starting interrupted work.
 * Pi's context is its memory view (src/memory); its agents are src/agents.
 */
export async function openInstance({
  databasePath,
  memoryDir = databasePath.replace(/(\.sqlite)?$/, '.unii'),
  cwd,
  model,
  thinkingLevel = 'high',
  allowTools = false,
  protection,
  configureAgent = true,
  models,
  onReport,
}: InstanceOptions): Promise<Instance> {
  const context = BACKGROUND_CONTEXT;
  // Inspection runs no turns or compactions, so it leaves the memory directory unopened.
  const memory = configureAgent ? openMemory(memoryDir, { models, model, ...compactionFor(model, models) }) : undefined;
  let opened: Harness | undefined;
  const Unii = createUniiExtension({ memory,
    resolveAgentChat: async (name, page) => {
      if (!opened) throw new Error('Harness is not open');
      return agentTranscript(opened, name, context, page);
    },
    // Upstream's "Agents at work now", read from the agents' runs so it never drifts from them.
    atWork: async () => opened ? (await listAgents(opened, context)).filter(agent => agent.busy).map(agent => agent.name) : [],
  });
  // Spawned agents copy Pi's choices; the chat's memory is Pi's alone.
  const childAgent: AgentChange = { extensions: { remove: [Unii] } };
  const Agents = createAgentsExtension({ childAgent, initialContext: async (_agent, _api, spawn) => {
    if (!memory) return undefined;
    await memory.settle(AGENT_VIEW_SETTLE_MS, spawn.abortSignal);
    return memory.render();
  } });
  const registry = createRegistry();
  // Register implementations even in chat-only mode, so pending tasks remain
  // recognizable. The persisted agent's enabled tools are replaced below.
  registry.install(CodingTools);
  registry.install(Unii);
  registry.install(Agents);
  const agent: AgentChange = {
    cwd,
    model,
    thinkingLevel,
    extensions: [CodingTools, Unii, Agents],
    tools: piTools([Unii, Agents], allowTools),
    modelTools: null,
    instructions: piInstructions(cwd, allowTools),
  };

  let database: HostDatabase | undefined;
  let storage: SqliteStorage | undefined;
  try {
    const hostDatabase = database = await openHostDatabase(databasePath);
    storage = await SqliteStorage.open(database);
    const harness = opened = await Harness.open(storage, {
      models,
      registry,
      env: ({ cwd: directory }) => protection ? new GuardedEnv({ cwd: directory ?? cwd, protection })
        : new NodeExecutionEnv({ cwd: directory ?? cwd }),
      onReport,
      // pi-durable compacts agents, which have no view, so their contexts stay bounded (ADR 0015). Pi's own
      // compactions are declined by the uniichat extension: its view keeps Pi's context a constant size.
      settings: { compaction: { enabled: true } },
    }, context);
    const root = await harness.root(context, configureAgent ? { agent } : undefined);
    // root({ agent }) only applies choices on creation. Every work launch must
    // overwrite them on reopen, especially tools enabled by an earlier launch.
    // Inspection deliberately leaves the persisted agent untouched.
    if (configureAgent) {
      await root.configure(agent, context);
      // Agents spawned under an earlier launch must not keep its tool choices.
      await syncAgents(harness, context, { childAgent });
    }
    /** Apply `change` to Pi, then re-derive every agent from Pi: the launch's path, so the same rules apply. */
    const reconfigure = async (change: AgentChange): Promise<void> => {
      if (!configureAgent) throw new Error('An inspection cannot change Pi\'s model or tools.');
      await root.configure(change, context);
      await syncAgents(harness, context, { childAgent });
    };
    return {
      harness,
      root,
      context,
      memory,
      models,
      async setModel(next) {
        await reconfigure({ model: next });
        const { compactionModel, jobs } = compactionFor(next, models);
        memory?.setSummarizer(createPiAiSummarizer({ models, model: compactionModel }), jobs);
      },
      setTools: enabled => reconfigure({ tools: piTools([Unii, Agents], enabled), instructions: piInstructions(cwd, enabled) }),
      setThinkingLevel: level => reconfigure({ thinkingLevel: level }),
      exclusive: step => hostDatabase.exclusive(step),
      close: async () => {
        try { await harness.close(context); } finally { await memory?.close(); }
      },
    };
  } catch (error) {
    try {
      if (opened) await opened.close(context);
      else if (storage) await storage.close(context);
      else if (database) await database.close();
      await memory?.close();
    } catch {
      // Preserve the opening failure, including when an API already closed
      // its owned database while handling that same failure.
    }
    throw error;
  }
}

/** All stored entries, including history hidden by resets or compactions. */
export async function transcript(root: Conversation, context: Context): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await root.entries({ order: 'ascending' }, 256, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

/** Read the committed answer for this submission, never a partial/live reply. */
export async function answerText(root: Conversation, settled: SubmissionRecord | undefined, context: Context): Promise<string> {
  if (settled?.status !== 'done' || settled.type !== 'input' || settled.answer === undefined) {
    const reason = settled?.reason ?? settled?.status ?? 'missing submission';
    const detail = settled?.detail === undefined ? ''
      : `: ${typeof settled.detail === 'string' ? settled.detail : JSON.stringify(settled.detail)}`;
    throw new Error(`Submission was not answered (${reason})${detail}`);
  }
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  if (!answer) throw new Error(`Committed assistant answer ${settled.answer} was not found`);
  return (answer.model ?? [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
