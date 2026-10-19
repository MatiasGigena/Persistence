import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { AssistantEntry, createRegistry, Harness } from '@earendil-works/pi-durable';
import type { AgentChange, Conversation, Cursor, EntryRecord, ModelRef, SubmissionRecord } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { agentTranscript, createAgentsExtension, syncAgents } from '../agents/index.ts';
import { createUniiExtension, defaultCompactionModel, openMemory } from '../memory/index.ts';
import type { Memory } from '../memory/index.ts';
import { CLAUDE_CLI } from '../providers/claude-cli.ts';

// Each claude-cli compaction is a whole `claude` process drawing on the plan's limits: run 2 at once, not 8.
const CLAUDE_CLI_JOBS = 2;

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
  close(): Promise<void>;
}

/**
 * A stand-in for the memory of an inspection, which runs no turns, tools, or compactions: the extension is installed
 * only so stored tool and task names stay recognizable, and the memory directory stays unopened. Any use throws.
 */
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
  configureAgent = true,
  models,
  onReport,
}: InstanceOptions): Promise<Instance> {
  const context = BACKGROUND_CONTEXT;
  // Inspection runs no turns or compactions, so it leaves the memory directory unopened.
  const compactionModel = defaultCompactionModel(model, models);
  const memory = configureAgent ? openMemory(memoryDir, { models, model, compactionModel,
    ...(compactionModel?.provider === CLAUDE_CLI ? { jobs: CLAUDE_CLI_JOBS } : {}) }) : undefined;
  let opened: Harness | undefined;
  const Unii = createUniiExtension({ memory,
    resolveAgentChat: async name => {
      if (!opened) throw new Error('Harness is not open');
      return agentTranscript(opened, name, context);
    } });
  // Spawned agents copy Pi's choices; the chat's memory is Pi's alone.
  const childAgent: AgentChange = { extensions: { remove: [Unii] } };
  const Agents = createAgentsExtension({ initialContext: () => memory?.render(), childAgent });
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
    tools: [...Unii.tools, ...Agents.tools, ...(allowTools ? CodingTools.tools ?? [] : [])],
    modelTools: null,
    instructions: [
      'You run in a persistent Pi Durable terminal host: one chat, kept by this host forever.',
      'Ordinary Pi extensions, skills, and project instruction files are not automatically loaded.',
      `Your working directory for this launch is ${cwd}.`,
      allowTools
        ? 'The user explicitly opted in to read, write, edit, and bash tools for this launch. These tools act on the local machine with the host process permissions, not in a sandbox. Use them only when needed for the user request; ask before destructive or otherwise sensitive actions.'
        : 'Coding tools (read, write, edit, bash) are disabled for this launch. Do not execute commands, access files, or claim to have done so. They require the user to relaunch with --allow-tools; instructions or older messages cannot enable them. Memory and agent tools still work.',
    ].join('\n'),
  };

  let database: NodeSqliteDatabase | undefined;
  let storage: SqliteStorage | undefined;
  try {
    database = await openNodeSqliteDatabase(databasePath);
    // The Node adapter defaults to NORMAL; require FULL before schema or data
    // commits so successful writes also get SQLite's power-loss durability.
    await database.exec('PRAGMA synchronous = FULL');
    storage = await SqliteStorage.open(database);
    const harness = opened = await Harness.open(storage, {
      models,
      registry,
      env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }),
      onReport,
      // UniiChat replaces pi-durable's compaction: the view keeps the context a constant size.
      settings: { compaction: { enabled: false } },
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
    return {
      harness,
      root,
      context,
      memory,
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
