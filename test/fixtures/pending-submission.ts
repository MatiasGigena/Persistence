import { setTimeout as delay } from 'node:timers/promises';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openInstance } from '../../src/runtime/runtime.ts';
import { offlineModels } from './faux-model.ts';

const [databasePath, cwd, requestId] = process.argv.slice(2);
const started = Promise.withResolvers();
const catalog = offlineModels([async () => {
  started.resolve();
  // Keep the model request genuinely in flight until the parent SIGKILLs us.
  await delay(60_000);
  return fauxAssistantMessage('This answer must never commit before the kill.');
}]);

try {
  const instance = await openInstance({ databasePath, cwd, ...catalog });
  const submission = await instance.root.submit({
    type: 'input', content: 'Recover this pending question exactly once.', requestId,
  }, instance.context);
  await started.promise;
  const status = await submission.status(instance.context);
  process.send({
    type: 'pending', rootId: instance.root.id, submissionId: submission.id,
    status: status.status, entryId: status.entry,
  });
  // No close: this fixture is deliberately terminated with SIGKILL.
} catch (error) {
  process.send?.({ type: 'error', message: error.stack ?? String(error) });
  process.exitCode = 1;
}
