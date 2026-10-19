// The model picker: the current model first and marked, then available ones; models without credentials stay
// listed, disabled, with their note. Picking one switches Pi and its agents from the next message.
import { el } from '../chat-view.ts';
import { errorText, modelRef, sortModels } from '../format.ts';
import type { ModelChoice } from '../../protocol/messages.ts';
import { renderRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

export function modelView(ctx: PanelContext): View {
  return {
    title: 'Model',
    render(body) {
      const current = ctx.store.status?.model ?? '';
      const note = el('p', 'sheet-note', `Current: ${current}. A new model applies from the next message.`);
      const list = el('ul', 'rows');
      const state = el('p', 'sheet-note', 'Loading models…');
      body.append(note, list, state);
      let busy = false;
      const pick = (models: readonly ModelChoice[], key: string): void => {
        const model = models.find(m => modelRef(m) === key);
        if (!model?.available || busy) return;
        if (key === current) { ctx.sheet.close(); return; }
        busy = true;
        state.hidden = false;
        state.classList.remove('is-error');
        state.textContent = `Switching to ${key}…`;
        ctx.link.request('model.set', { provider: model.provider, id: model.id }).then(
          () => {
            ctx.notice(`Model: ${key} (from the next message; saved as default)`);
            ctx.sheet.close();
          },
          (error: unknown) => {
            state.textContent = `Model not changed: ${errorText(error)}`;
            state.classList.add('is-error');
          },
        ).finally(() => { busy = false; });
      };
      ctx.link.request('models', {}).then(
        ({ models }) => {
          renderRows(list, sortModels(models, current).map(m => ({
            key: modelRef(m),
            label: m.name,
            detail: m.note ? `${modelRef(m)} · ${m.note}` : modelRef(m),
            mark: modelRef(m) === current ? 'current' : 'none',
            disabled: !m.available,
            className: 'row-model',
          })), key => pick(models, key));
          state.textContent = models.length ? '' : 'No models.';
          state.hidden = models.length > 0;
        },
        (error: unknown) => {
          state.textContent = `Could not list models: ${errorText(error)}`;
          state.classList.add('is-error');
        },
      );
    },
  };
}
