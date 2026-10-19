import { createModels } from '@earendil-works/pi-ai/models';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { FauxProviderHandle, FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import type { ModelRef } from '@earendil-works/pi-durable';

export type OfflineModels = { models: MutableModels; faux: FauxProviderHandle; model: ModelRef };

// Explicit in-memory catalog: never loads credentials or real providers.
export function offlineModels(responses: FauxResponseStep[] = []): OfflineModels {
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
