import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createAgentsExtension, syncAgents } from '../../src/agents/index.ts';

const context = BACKGROUND_CONTEXT;

/** A Harness wired the way the host is expected to wire the agents extension. */
export async function openAgents({ databasePath, cwd, models, model, hooks = {} }) {
  const Agents = createAgentsExtension(hooks);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Agents);
  const agent = { cwd, model, thinkingLevel: 'off', extensions: [CodingTools, Agents],
    tools: [...Agents.tools], modelTools: null, instructions: 'Offline agents test.' };
  const database = await openNodeSqliteDatabase(databasePath);
  const storage = await SqliteStorage.open(database);
  const harness = await Harness.open(storage, { models, registry,
    env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }) }, context);
  const root = await harness.root(context, { agent });
  await root.configure(agent, context);
  await syncAgents(harness, context);
  return { harness, root, context, close: () => harness.close(context) };
}

const textOf = (content) => typeof content === 'string' ? content
  : content.filter((block) => block.type === 'text').map((block) => block.text).join('');
export const call = (...calls) => fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)),
  { stopReason: 'toolUse' });
export const say = (value) => fauxAssistantMessage([fauxText(value)]);

/**
 * One scripted model shared by every conversation. `script[who](turn)` answers a request, where
 * `who` is "Pi" or the agent's name (read from its agents section) and `turn` holds the last user
 * text and the tool results since then.
 */
export function router(script, seen = []) {
  const step = (request, options) => {
    const system = JSON.stringify(request.messages.filter((message) => message.role === 'system'));
    const who = /You are Pi, the session agent/.test(system) ? 'Pi'
      : /You are \\"([A-Za-z0-9_-]+)\\", a (main|sub) agent/.exec(system)?.[1] ?? 'unknown';
    const index = request.messages.findLastIndex((message) => message.role === 'user');
    const user = index < 0 ? '' : textOf(request.messages[index].content);
    const results = request.messages.slice(index + 1).filter((message) => message.role === 'toolResult')
      .map((message) => ({ name: message.toolName, text: textOf(message.content), isError: message.isError }));
    const turn = { who, user, results, last: results.at(-1), request, signal: options?.signal };
    seen.push(turn);
    const answer = script[who]?.(turn);
    if (!answer) throw new Error(`No scripted answer for ${who}: ${user} / ${JSON.stringify(results)}`);
    return answer;
  };
  return Array.from({ length: 400 }, () => step);
}
