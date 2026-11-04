import { setTimeout as sleep } from 'node:timers/promises';
import { answerText } from './runtime.ts';
import type { Instance } from './runtime.ts';

type Opened = Pick<Instance, 'harness' | 'root' | 'context'>;

// A failed run can leave only queued input, with no task for resume() to run.
// An empty context-affecting write advances that queue without adding a prompt.
// `onResume` hears how many tasks there were, once, when there is anything to resume.
export async function resumeInstance(
  { harness, root, context }: Opened, { onResume }: { readonly onResume?: (tasks: number) => void } = {},
): Promise<void> {
  const inspection = await harness.inspect(context);
  if (!inspection.tasks.length && !inspection.submissions.length) return;
  onResume?.(inspection.tasks.length);
  await root.submit({ type: 'write', entry: { kind: 'host.resume-boundary', model: [] } }, context);
  harness.resume();
  for (const record of inspection.submissions) {
    if (record.type !== 'input') continue;
    const submission = await harness.submission(record.id, context);
    if (submission) await answerText(root, await submission.wait(context), context);
  }
  await root.waitForIdle(context);
}

/** Whether `task` is work still underway: each agent's anchor task lives as long as the agent, so it is not. */
export const isWork = (task: { readonly record: { readonly kind: string } }): boolean => task.record.kind !== 'agents.anchor';

// Agents work in background tasks that outlive the root's runs.
export async function settleAgents(
  { harness, root, context }: Opened, { signal, intervalMs = 250 }: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<void> {
  harness.resume();
  while (!signal?.aborted) {
    await root.waitForIdle(context);
    const { tasks } = await harness.inspect(context);
    if (!tasks.some(isWork) || signal?.aborted) return;
    // An abort ends the wait at once instead of after the interval.
    try { await sleep(intervalMs, undefined, signal ? { signal } : {}); } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }
}
