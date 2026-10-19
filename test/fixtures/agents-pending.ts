import { setTimeout as delay } from 'node:timers/promises';
import { call, openAgents, router, say } from './agents-instance.ts';
import { offlineModels } from './faux-model.ts';

// Pi spawns M, M spawns S; S's model request stays in flight until the parent SIGKILLs us.
const [databasePath, cwd] = process.argv.slice(2);
const started = Promise.withResolvers<void>();
const reported = Promise.withResolvers<void>();
const catalog = offlineModels(router({
  Pi: ({ user, last }) => {
    if (user === 'go' && !last) return call(['spawn_agent', { name: 'M', task: 'work' }]);
    if (last) return say('spawned');
    // Keep Pi's run on M's first report in flight too.
    if (user.startsWith('[M]')) return delay(60_000).then(() => say('never'));
  },
  M: ({ last }) => last ? say('M waiting') : call(['spawn_agent', { name: 'S', task: 'slow job' }]),
  S: async () => { started.resolve(); await delay(60_000); return say('never'); },
}));

try {
  if (databasePath === undefined || cwd === undefined) throw new Error('usage: agents-pending.ts <databasePath> <cwd>');
  if (!process.send) throw new Error('agents-pending.ts needs an IPC channel');
  const instance = await openAgents({ databasePath, cwd, ...catalog, hooks: { onReport: () => reported.resolve() } });
  await (await instance.root.submit({ type: 'input', content: 'go' }, instance.context)).wait(instance.context);
  await Promise.all([started.promise, reported.promise]);
  process.send({ type: 'pending' });
  // No close: this fixture is deliberately terminated with SIGKILL.
} catch (error) {
  process.send?.({ type: 'error', message: error instanceof Error ? error.stack ?? String(error) : String(error) });
  process.exitCode = 1;
}
