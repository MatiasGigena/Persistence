// Stopping, deleting, archiving, restoring and purging agents: the operations the session, the server and the agent
// tools share. Each refuses an unknown name with NotFound.
import type { Context, Draft } from '@earendil-works/chord';
import type { ConversationId, Session, Tx } from '@earendil-works/pi-durable';
import type { Roster } from './roster.ts';
import { rosterEntry } from './roster.ts';
import { NotFound } from '../protocol/errors.ts';
import type { ArchiveTarget } from '../protocol/session.ts';
import { PI, AgentsDoc, findAgent, noAgent, ARCHIVE_TTL_MS, archivedSince, archivedRefusal, sessionsOf, busyNames } from './registry.ts';
import type { AgentRecord, AgentsState, AgentsSource, Named, AgentsStopper } from './registry.ts';
import { deliveryTargets } from './delivery.ts';

/**
 * Stop agent `name` and its sub agents, or every agent without a name (upstream UniiChat's stop of all work); Pi is
 * not touched. Sub agents go first, since a sub's report would otherwise wake its stopped main again. Each agent's
 * every conversation is stopped, a standing agent's past sessions too. A stopped run reports nothing. Returns the
 * names stopped, `name` last; rejects with NotFound for an unknown name, as archive and restore do.
 */
export async function stopAgents(source: AgentsStopper, context: Context, name?: string): Promise<string[]> {
  const agents = (await source.snapshot(AgentsDoc, context))?.agents ?? {};
  const found = name === undefined ? undefined : findAgent(agents, name);
  if (name !== undefined && !found) throw new NotFound(noAgent(agents, name));
  const chosen = found ? Object.keys(agents).filter((each) => agents[each]?.parent === found.name || each === found.name) : Object.keys(agents);
  return stopNamed(source, context, agents, chosen);
}

/** Stop every conversation of the agents `names` of `agents`, subs first; returns them in that order. */
export async function stopNamed(source: AgentsStopper, context: Context, agents: Readonly<Record<string, AgentRecord>>,
  names: readonly string[]): Promise<string[]> {
  const chosen = names.flatMap((each): [string, AgentRecord][] => { const agent = agents[each]; return agent ? [[each, agent]] : []; });
  const groups = (['sub', 'main'] as const).map(role => chosen.filter(([, agent]) => agent.role === role));
  // Each group's agents stop together, every session at once; the subs are stopped before any main is.
  const abort = async (id: ConversationId) => { await (await source.conversation(id, context))?.abort(context); };
  for (const group of groups) await Promise.all(group.flatMap(([, agent]) => sessionsOf(agent).map(abort)));
  return groups.flat().map(([each]) => each);
}

/**
 * The outcome of deleting an agent: the names removed (its subs first, the agent last), or why nothing was; `unknown`
 * when no agent has that name.
 */
export type DeleteResult = { readonly deleted: readonly string[] } | { readonly error: string; readonly unknown?: true };

/** The text `delete_agent` returns for a result. */
export const deleteText = (result: DeleteResult): string => {
  if ('error' in result) return result.error;
  const [name = '', ...rest] = [...result.deleted].reverse();
  const also = rest.length ? ` and its sub agents ${rest.reverse().join(', ')}` : '';
  return `Deleted ${name}${also}. ${rest.length ? 'Their chats stay' : 'Its chat stays'} readable with zoom("${name}").`;
};

/**
 * Remove agent `name` (a main agent with its sub agents) from the registry, in the commit of `tx`. Refused for an
 * unknown name, a standing agent (`standing`, or a roster name), an agent with a run in any of its conversations or
 * one of its subs with one (`busy`: names), and while an input to any of them is still on its way (an unfinished
 * `agents.deliver` task): stop it first. The conversations are not erased (the SDK has no such operation): they stay in
 * the database, owned by their finished anchor tasks, and `deleted` keeps their ids for `zoom("Name")`. The name is free
 * again for spawn_agent. Idempotent per call through `once`; a second delete of the same name finds no agent.
 */
export async function removeAgent(tx: Tx, registry: Draft<AgentsState>, name: string, busy: ReadonlySet<string>,
  roster: Roster | undefined): Promise<DeleteResult> {
  const found = findAgent(registry.agents, name);
  if (String(name).toLowerCase() === PI.toLowerCase()) return { error: 'Pi cannot be deleted.' };
  if (!found) return { error: noAgent(registry.agents, name), unknown: true };
  if (found.standing || (roster && rosterEntry(roster, found.name))) {
    return { error: `${found.name} is a standing agent; it can be deleted only after it leaves the roster.` };
  }
  // The user archived it, so it is theirs to restore or let go: the sweep deletes it (ADR 0034).
  const archived = archivedRefusal(registry.agents, found.name);
  if (archived !== undefined) return { error: archived };
  const subs = found.role === 'main'
    ? Object.entries(registry.agents).filter(([, agent]) => agent.role === 'sub' && agent.parent === found.name).map(([each]) => each) : [];
  const chosen = [...subs, found.name];
  const working = chosen.filter((each) => busy.has(each));
  if (working.length) return { error: `${working.join(', ')} ${working.length === 1 ? 'is' : 'are'} busy; stop_agent ${found.name} first, then delete it.` };
  const targets = await deliveryTargets(tx, registry.agents);
  const queued = chosen.filter((each) => sessionsOf(registry.agents[each] ?? found).some((id) => targets.has(id)));
  if (queued.length) return { error: `A message to ${queued.join(', ')} is still on its way; stop_agent ${found.name} first, then delete it.` };
  // A value assigned to a draft is stored as a detached copy: edit it through the draft.
  registry.deleted ??= {};
  const deleted = registry.deleted;
  for (const each of chosen) {
    const agent = registry.agents[each];
    if (!agent) continue;
    // A name deleted before (then spawned again) keeps only its newest chat.
    for (const key of Object.keys(deleted)) if (key.toLowerCase() === each.toLowerCase()) delete deleted[key];
    deleted[each] = sessionsOf(agent);
    delete registry.agents[each];
  }
  return { deleted: chosen };
}

/**
 * Delete agent `name` and its sub agents for the host (see `removeAgent`): never Pi or a standing agent, never a busy
 * one. `roster` refuses its names even before a launch synced them. Returns the names deleted, subs first; throws the
 * refusal, as `archiveAgents` and `restoreAgent` do (NotFound for an unknown name). The `delete_agent` tool returns
 * the refusal as its text instead.
 */
export async function deleteAgent(source: AgentsSource, context: Context, name: string, roster?: Roster): Promise<string[]> {
  const busy = await busyNames(source, context);
  const result = await source.commit(async (tx) => removeAgent(tx, await tx.doc(AgentsDoc), name, busy, roster), context);
  if ('error' in result) throw result.unknown ? new NotFound(result.error) : new Error(result.error);
  return [...result.deleted];
}

/**
 * The agents `target` archives in `agents`: a main agent with its subs, a sub alone, or every ad-hoc main agent with its
 * subs. Throws the refusal for an unknown name or a standing agent.
 */
export function archiveSet(agents: Readonly<Record<string, AgentRecord>>, target: ArchiveTarget): string[] {
  const withSubs = (main: string) => [main, ...Object.keys(agents).filter((each) => agents[each]?.role === 'sub' && agents[each].parent === main)];
  // Every ad-hoc main agent not archived yet, with its subs.
  if ('adhoc' in target) {
    return Object.entries(agents).filter(([, agent]) => agent.role === 'main' && !agent.standing && agent.archivedAt === undefined)
      .flatMap(([name]) => withSubs(name));
  }
  const found = findAgent(agents, target.name);
  if (!found) throw new NotFound(noAgent(agents, target.name));
  if (found.standing) throw new Error(`${found.name} is a standing agent; remove it from the roster first.`);
  return found.role === 'main' ? withSubs(found.name) : [found.name];
}

/**
 * Archive `target` (ADR 0034): stop its work, then record `archivedAt = now` on each agent it names, in one commit, then
 * stop again whatever a delivery started in between. An agent already archived keeps its time. Returns the names
 * archived, subs included; `{ adhoc: true }` takes the ad-hoc main agents not archived yet, so may archive nothing. Throws `No agent named X.` or
 * `X is a standing agent; remove it from the roster first.` A crash before the commit leaves the agents only stopped,
 * and archiving again converges.
 */
export async function archiveAgents(source: AgentsSource & AgentsStopper, context: Context, target: ArchiveTarget,
  now: number): Promise<string[]> {
  const before = (await source.snapshot(AgentsDoc, context))?.agents ?? {};
  await stopNamed(source, context, before, archiveSet(before, target));
  const archived = await source.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    // The registry as it is now: a sub spawned since the snapshot goes with its main.
    const names = archiveSet(registry.agents, target);
    for (const name of names) {
      const agent = registry.agents[name];
      if (agent && agent.archivedAt === undefined) agent.archivedAt = now;
    }
    return names;
  }, context);
  await stopNamed(source, context, (await source.snapshot(AgentsDoc, context))?.agents ?? {}, archived);
  return archived;
}

/**
 * Restore archived agent `name`: clear its `archivedAt`, and its subs' for a main agent. Stopped work is not resumed.
 * Returns the names restored, `name` first. Throws for an unknown agent, one not archived, or a sub whose main agent is
 * archived (restore that one).
 */
export async function restoreAgent(source: AgentsSource, context: Context, name: string): Promise<string[]> {
  const check = (agents: Readonly<Record<string, AgentRecord>>): Named => {
    const found = findAgent(agents, name);
    if (!found) throw new NotFound(noAgent(agents, name));
    if (archivedSince(agents, found.name) === undefined) throw new Error(`${found.name} is not archived.`);
    if (found.role === 'sub' && agents[found.parent]?.archivedAt !== undefined) {
      throw new Error(`${found.name}'s main agent ${found.parent} is archived; restore ${found.parent}.`);
    }
    return found;
  };
  check((await source.snapshot(AgentsDoc, context))?.agents ?? {});
  return source.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    const found = check(registry.agents);
    const restored = [found.name];
    delete registry.agents[found.name]?.archivedAt;
    if (found.role === 'main') {
      for (const [each, agent] of Object.entries(registry.agents)) {
        if (agent.role === 'sub' && agent.parent === found.name && agent.archivedAt !== undefined) {
          delete agent.archivedAt;
          restored.push(each);
        }
      }
    }
    return restored;
  }, context);
}

/**
 * Delete every agent archived for `maxAgeMs` or more at `now` (a sub of an archived main counts from its main's time, so
 * goes with it): its registry record goes, its name is free again, and its conversations stay unreferenced (pi-durable
 * cannot delete one). One commit, which changes nothing when nothing is due. Returns the names deleted.
 */
export async function purgeArchived(source: Pick<Session, 'commit'>, context: Context, now: number,
  maxAgeMs: number = ARCHIVE_TTL_MS): Promise<string[]> {
  return source.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    const due = Object.keys(registry.agents).filter((name) => {
      const since = archivedSince(registry.agents, name);
      return since !== undefined && now - since >= maxAgeMs;
    });
    // As delete_agent does: the name is free again, and `deleted` keeps its chat for zoom("Name").
    registry.deleted ??= {};
    const deleted = registry.deleted;
    for (const name of due) {
      const agent = registry.agents[name];
      if (!agent) continue;
      for (const key of Object.keys(deleted)) if (key.toLowerCase() === name.toLowerCase()) delete deleted[key];
      deleted[name] = sessionsOf(agent);
      delete registry.agents[name];
    }
    return due;
  }, context);
}
