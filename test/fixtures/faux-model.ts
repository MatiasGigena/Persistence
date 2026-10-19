import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';

// Explicit in-memory catalog: never loads credentials or real providers.
export function offlineModels(responses = []) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const selected = faux.getModel();
  return {
    models,
    faux,
    model: { provider: selected.provider, modelId: selected.id },
  };
}
