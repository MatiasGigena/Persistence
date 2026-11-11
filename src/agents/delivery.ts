// The Deliver task: every input to an agent travels in one, keyed by its task ID, so a restart resumes it and nothing is
// delivered twice; its answer is reported to the parent by the next Deliver task, created in the same commit.
import type { Context } from '@earendil-works/chord';
import { AssistantEntry, ROOT_CONVERSATION_ID, defineTask } from '@earendil-works/pi-durable';
import type { ConversationId, Cursor, NextTaskState, SettledSubmissionRecord, TaskId, TaskRuntime, Tx } from '@earendil-works/pi-durable';
import { REPORT_KIND, assistantText } from './entries.ts';
import { isRecord } from '../protocol/util.ts';
import { PI, KEEP_REPORTED, piReportText, AgentsDoc, archivedSince, sessionNumber, staleSub, TASK_OPTIONS } from './registry.ts';
import type { AgentRecord, MessageEntry, ReportEntry } from './registry.ts';
import type { AgentsOptions } from './setup.ts';

export type DeliverState = { phase: 'deliver' };

export type DeliveryInput = {
  to: string;
  conversationId: ConversationId;
  content: string;
  entry: MessageEntry | ReportEntry;
  whenBusy: 'steer' | 'followUp';
};

export const DELIVER_KIND = 'agents.deliver';

/** The memo of an `agents.deliver` task that fixes where its message goes once it was redirected (see Deliver). */
export const SESSION_MEMO = 'session';

/**
 * The conversations an unfinished `agents.deliver` task still carries an input to (its redirected session, else its
 * input's), read in the commit of `tx`. A delivery stays unfinished until its input was answered. One bound for a past
 * session of an agent in `agents` that has not chosen yet counts for that agent's current session too: Deliver may
 * redirect it there, and the choice is kept only after its commit.
 */
export async function deliveryTargets(tx: Tx, agents: Readonly<Record<string, AgentRecord>>): Promise<ReadonlySet<unknown>> {
  const targets = new Set<unknown>();
  for (const status of ['pending', 'running', 'waiting'] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ kind: DELIVER_KIND, status }, 64, cursor);
      for (const task of page.items) {
        const input = isRecord(task.input) ? task.input : undefined;
        const memo = task.memos?.[SESSION_MEMO];
        const to = memo ?? input?.conversationId;
        if (to !== undefined) targets.add(to);
        const agent = memo === undefined && typeof input?.to === 'string' ? agents[input.to] : undefined;
        if (agent?.past?.some((id) => id === input?.conversationId)) targets.add(agent.conversationId);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return targets;
}

/** The Deliver task, which carries one input to one agent and then that agent's answer to its parent, and how to create one. */
export function deliveries({ onReport, onDelivery }: AgentsOptions) {
  const done = (): NextTaskState<DeliverState, null> => ({ status: 'terminal', outcome: { status: 'completed', result: null } });

  /**
   * The conversation delivery `input` (request `requestId`) submits into: its own, unless that is a past session of its
   * agent. A report into a past session comes from a sub of a task the agent no longer works on, so it is dropped
   * (undefined). A message goes to the current session instead, so a task that is over never wakes; the choice is made
   * in a commit, from the registry as it is then (a snapshot may predate a delegate), and kept in a memo before the
   * submit, so a replay after a crash submits to the same conversation, where the request id returns the first
   * submission. Until the memo exists, deliveryTargets counts the current session for it, so delegate refuses.
   * delegate refuses while a delivery to the current session is unfinished, and `past` only grows, so a target the
   * snapshot `agents` does not show as past stays current.
   */
  async function deliverySession(input: DeliveryInput, agents: Readonly<Record<string, AgentRecord>>, requestId: string,
    runtime: TaskRuntime<DeliveryInput, DeliverState, null, object>, context: Context): Promise<ConversationId | undefined> {
    const { to, entry, conversationId: original } = input;
    if (!agents[to]?.past?.includes(original)) return original;
    if (entry.kind === REPORT_KIND) return undefined;
    const chosen = await runtime.memo<ConversationId>(SESSION_MEMO, context);
    if (chosen !== undefined) return chosen;
    // A task runtime's commit returns nothing, so the choice leaves it through this holder.
    const choice: { session?: ConversationId } = {};
    await runtime.commit(async (tx) => {
      const agent = (await tx.doc(AgentsDoc)).agents[to];
      // One that already reached the past session (before a crash) stays there: it must not arrive twice.
      const reached = await tx.submissionByRequest(original, requestId) !== undefined;
      choice.session = reached || !agent ? original : agent.conversationId;
      return undefined;
    }, context);
    return runtime.memo(SESSION_MEMO, choice.session ?? original, context);
  }

  /**
   * In the commit of `tx`: record agent `to`'s answer in `settled` (from its conversation `conversationId`) as reported,
   * and deliver it to the agent's parent. A failed run reports why; a stopped one reports nothing (its stopper knows).
   */
  async function recordAnswer(tx: Tx, to: string, settled: SettledSubmissionRecord, conversationId: ConversationId) {
    const answer = settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined;
    const answerEntry = answer && await tx.entry(AssistantEntry, answer);
    const registry = await tx.doc(AgentsDoc);
    const agent = registry.agents[to];
    if (!agent) return done();
    let report: string | undefined;
    if (settled.status === 'unanswered') {
      const detail = typeof settled.detail === 'string' && settled.detail ? `: ${settled.detail}` : '';
      if (settled.reason !== 'aborted') report = `failed: ${settled.reason}${detail}`;
    } else if (answer && !agent.reported.includes(answer)) {
      agent.reported.push(answer);
      if (agent.reported.length > KEEP_REPORTED) agent.reported.splice(0, agent.reported.length - KEEP_REPORTED);
      // As upstream, every answered run reports, even with an empty reply, so the parent learns it ended.
      report = assistantText(answerEntry).trim() || '(no reply)';
    }
    // A sub of a standing agent's past session reports nowhere: its task is over (delegate switched sessions once the
    // sub was idle), so only a message woke it since, and no session waits for its report. An archived agent's report
    // goes nowhere either; the user put it away.
    if (report === undefined || staleSub(registry.agents, agent) || archivedSince(registry.agents, to) !== undefined) return done();
    const parent = agent.parent === PI ? ROOT_CONVERSATION_ID : registry.agents[agent.parent]?.conversationId;
    if (!parent) return done();
    // A report to Pi names the session it came from, so its link keeps opening that one.
    const session = agent.parent === PI ? sessionNumber(agent, conversationId) : undefined;
    await createDelivery(tx, {
      to: agent.parent, conversationId: parent, whenBusy: 'followUp',
      content: agent.parent === PI ? piReportText(to, report, session) : `[${to}] ${report}`,
      entry: { kind: REPORT_KIND, data: { name: to, text: report, ...session === undefined ? {} : { session } } },
    }, { source: conversationId });
    return done();
  }

  // Carries one input to one agent, then that agent's answer to its parent.
  const Deliver = defineTask<DeliveryInput, DeliverState, null>({
    name: DELIVER_KIND,
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { to, content, entry, whenBusy } = task.input;
        const requestId = `agents:${task.id}`;
        const agents = (await runtime.snapshot(AgentsDoc, context))?.agents ?? {};
        // An input to an archived or deleted agent completes without submitting, and so does a report from one, even one
        // on its way before the archive (ADR 0034).
        const gone = (name: string) => name !== PI && (!agents[name] || archivedSince(agents, name) !== undefined);
        if (gone(to) || (entry.kind === REPORT_KIND && gone(entry.data.name))) return runtime.commit(done, context);
        const conversationId = await deliverySession(task.input, agents, requestId, runtime, context);
        const conversation = conversationId === undefined ? undefined : await runtime.conversation(conversationId, context);
        if (conversationId === undefined || !conversation) return runtime.commit(done, context);
        // A report carries its delivery's id, so memory logs each report once, even identical ones.
        const placed = entry.kind === REPORT_KIND ? { ...entry, data: { ...entry.data, id: task.id } } : entry;
        const submission = await conversation.submit({ type: 'input', content, entry: placed, whenBusy, requestId }, context);
        if (conversationId === ROOT_CONVERSATION_ID) {
          await runtime.commit(done, context);
          // Pi is only ever delivered reports.
          try { if (entry.kind === REPORT_KIND) await onReport?.({ ...entry.data, id: task.id }); }
          catch (error) { runtime.report(error); }
          return;
        }
        const settled = await submission.wait(context);
        // One commit records the answer as reported and creates its delivery to the parent.
        await runtime.commit((tx) => recordAnswer(tx, to, settled, conversationId), context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  /**
   * Create the Deliver task for `delivery` in the commit of `tx`. `source` is the conversation the input comes from;
   * `owner` the one that owns the task, by default the committing tool call's own.
   */
  const createDelivery = async (tx: Tx, delivery: DeliveryInput,
    { source, owner }: { readonly source: ConversationId; readonly owner?: ConversationId }): Promise<TaskId<null>> => {
    const { conversationId } = delivery;
    const id = await tx.createTask(Deliver, delivery, owner === undefined ? TASK_OPTIONS : { ...TASK_OPTIONS, conversationId: owner });
    // The caller supplies the actual sending/answered session, not its standing agent's mutable current session.
    // Its metadata and the delivery commit together, so replay cannot submit before a source binding exists.
    await onDelivery?.(tx, source, conversationId, `agents:${id}`);
    return id;
  };
  return { Deliver, createDelivery };
}
