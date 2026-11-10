import type { Context } from '@earendil-works/chord/context';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  AssistantMessage, ImageContent, JsonObject, Models, SimpleStreamOptions, TextContent, TranscriptContext,
} from '@earendil-works/pi-ai';
import { fauxAssistantMessage, type FauxResponseStep, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { type AgentChange, type Conversation, createRegistry, Harness, type ModelRef, type Storage } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { type AgentsOptions, createAgentsExtension, syncAgents } from '../../src/agents/index.ts';

const context = BACKGROUND_CONTEXT;

export interface AgentsInstance {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly context: Context;
  /** Test-only: mints fresh IDs, e.g. task IDs for direct tool calls. */
  readonly storage: Storage;
  close(): Promise<void>;
}

/** A Harness wired the way the host is expected to wire the agents extension. */
export async function openAgents({ databasePath, cwd, models, model, hooks = {} }: {
  readonly databasePath: string;
  readonly cwd: string;
  readonly models: Models;
  readonly model: ModelRef;
  readonly hooks?: AgentsOptions;
}): Promise<AgentsInstance> {
  const Agents = createAgentsExtension(hooks);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Agents);
  const agent: AgentChange = { cwd, model, thinkingLevel: 'off', extensions: [CodingTools, Agents],
    tools: [...Agents.tools], modelTools: null, instructions: 'Offline agents test.' };
  const database = await openNodeSqliteDatabase(databasePath);
  const storage = await SqliteStorage.open(database);
  const harness = await Harness.open(storage, { models, registry,
    env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }) }, context);
  const root = await harness.root(context, { agent });
  await root.configure(agent, context);
  await syncAgents(harness, context);
  return { harness, root, context, storage, close: () => harness.close(context) };
}

const textOf = (content: string | readonly (TextContent | ImageContent)[]) => typeof content === 'string' ? content
  : content.filter((block) => block.type === 'text').map((block) => block.text).join('');
export const call = (...calls: (readonly [string, JsonObject])[]) =>
  fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: 'toolUse' });
export const say = (value: string) => fauxAssistantMessage([fauxText(value)]);

/** A tool result as a script sees it. */
export interface TurnResult {
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
}
/** One model request, as routed to `script[who]`. */
export interface Turn {
  readonly who: string;
  readonly user: string;
  readonly results: readonly TurnResult[];
  readonly last: TurnResult | undefined;
  readonly request: TranscriptContext;
  readonly signal: AbortSignal | undefined;
}
export type Script = Readonly<Record<string, (turn: Turn) => AssistantMessage | Promise<AssistantMessage> | undefined>>;

/**
 * One scripted model shared by every conversation. `script[who](turn)` answers a request, where
 * `who` is "Pi" or the agent's name (read from its agents section) and `turn` holds the last user
 * text and the tool results since then.
 */
export function router(script: Script, seen: Turn[] = []): FauxResponseStep[] {
  const step = (request: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    const system = JSON.stringify(request.messages.filter((message) => message.role === 'system'));
    const who = /You are Pi, the session agent/.test(system) ? 'Pi'
      : /You are \\"([A-Za-z0-9_-]+)\\", a (main|sub) agent/.exec(system)?.[1] ?? 'unknown';
    const index = request.messages.findLastIndex((message) => message.role === 'user');
    const message = request.messages[index];
    const user = message?.role === 'user' ? textOf(message.content) : '';
    const results = request.messages.slice(index + 1).filter((each) => each.role === 'toolResult')
      .map((each) => ({ name: each.toolName, text: textOf(each.content), isError: each.isError }));
    const turn = { who, user, results, last: results.at(-1), request, signal: options?.signal };
    seen.push(turn);
    const answer = script[who]?.(turn);
    if (!answer) throw new Error(`No scripted answer for ${who}: ${user} / ${JSON.stringify(results)}`);
    return answer;
  };
  return Array.from({ length: 400 }, () => step);
}
