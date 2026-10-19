import { answerText } from './runtime.ts';

// A failed run can leave only queued input, with no task for resume() to run.
// An empty context-affecting write advances that queue without adding a prompt.
export async function resumeInstance({ harness, root, context }) {
  const inspection = await harness.inspect(context);
  if (!inspection.tasks.length && !inspection.submissions.length) return;
  await root.submit({ type: 'write', entry: { kind: 'host.resume-boundary', model: [] } }, context);
  harness.resume();
  for (const record of inspection.submissions) {
    if (record.type !== 'input') continue;
    const submission = await harness.submission(record.id, context);
    if (submission) await answerText(root, await submission.wait(context), context);
  }
  await root.waitForIdle(context);
}

// Agents work in background tasks that outlive the root's runs. Each agent's
// anchor task lives as long as the agent; anything else is work still underway.
export async function settleAgents({ harness, root, context }, { signal, intervalMs = 250 } = {}) {
  harness.resume();
  for (;;) {
    await root.waitForIdle(context);
    const { tasks } = await harness.inspect(context);
    if (tasks.every(task => task.record.kind === 'agents.anchor')) return;
    if (signal?.aborted) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
