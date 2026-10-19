import { createModels } from '@earendil-works/pi-ai/models';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { FauxProviderHandle, FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import type { ModelRef } from '@earendil-works/pi-durable';

export type OfflineModels = { models: MutableModels; faux: FauxProviderHandle; model: ModelRef };

// Explicit in-memory catalog: never loads credentials or real providers. `contextWindow` sizes its one model.
export function offlineModels(responses: FauxResponseStep[] = [], { contextWindow }: { contextWindow?: number } = {}): OfflineModels {
  const faux = fauxProvider(contextWindow === undefined ? undefined : { models: [{ id: 'faux-small', contextWindow }] });
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
