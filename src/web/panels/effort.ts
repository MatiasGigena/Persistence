// The reasoning effort picker, opened from the chip beside the model's: the current model's levels, lowest first, the
// current one marked. Picking one sets it for Pi and its agents from the next request, and saves it as the default.
import { el } from '../chat-view.ts';
import { errorText } from '../format.ts';
import { renderRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

/** What each level means, in a few words. */
export const EFFORT_HINTS: Readonly<Record<string, string>> = {
  off: 'No reasoning', minimal: 'The least reasoning', low: 'Quick answers', medium: 'Balanced',
  high: 'The default', xhigh: 'Harder problems, slower', max: 'The most reasoning, slowest',
};

export function effortView(ctx: PanelContext): View {
  return {
    title: 'Effort',
    render(body) {
      const current = ctx.store.status?.thinkingLevel ?? '';
      const model = ctx.store.status?.model ?? '';
      const note = el('p', 'sheet-note', `How much ${model} reasons before it answers. A new level applies from the next request.`);
      const list = el('ul', 'rows');
      const state = el('p', 'sheet-note', 'Loading levels…');
      body.append(note, list, state);
      let busy = false;
      const pick = (level: string): void => {
        if (busy) return;
        if (level === current) { ctx.sheet.close(); return; }
        busy = true;
        state.hidden = false;
        state.classList.remove('is-error');
        state.textContent = `Setting ${level}…`;
        ctx.link.request('thinking.set', { level }).then(
          () => {
            ctx.notice(`Effort: ${level} (from the next request; saved as default)`);
            ctx.sheet.close();
          },
          (error: unknown) => {
            state.textContent = `Effort not changed: ${errorText(error)}`;
            state.classList.add('is-error');
          },
        ).finally(() => { busy = false; });
      };
      ctx.link.request('thinking.levels', {}).then(
        ({ levels }) => {
          renderRows(list, levels.map(level => ({
            key: level,
            label: level,
            detail: EFFORT_HINTS[level] ?? '',
            mark: level === current ? 'current' : 'none',
          })), pick);
          state.textContent = levels.length ? '' : 'No levels.';
          state.hidden = levels.length > 0;
        },
        (error: unknown) => {
          state.textContent = `Could not list levels: ${errorText(error)}`;
          state.classList.add('is-error');
        },
      );
    },
  };
}
