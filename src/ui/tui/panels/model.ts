// /model: the model picker, after Pi's own selector. The current model comes first, marked ✓; typing
// filters. Models without credentials stay listed, dim, and answer Enter with their note instead.
import type { TUI } from '@earendil-works/pi-tui';
import { NARROW } from '../theme.ts';
import type { ModelChoice, UiSession } from '../../types.ts';
import { clean, ListView, openPanel, PanelFrame } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';

/** "provider/id": what /model takes and SessionStatus.model shows. */
export const modelRef = (model: { readonly provider: string; readonly id: string }): string => `${model.provider}/${model.id}`;

/**
 * Opens the picker over the chat, filtered by `filter` as if typed. Resolves, once it has closed and the editor has
 * focus again, with the available model chosen with Enter, or undefined after Esc. Switching to it is the caller's job.
 */
export async function openModelPanel(tui: TUI, session: UiSession, theme: PanelTheme, filter = ''): Promise<ModelChoice | undefined> {
  let models: readonly ModelChoice[] | undefined, failure: string | undefined, hint: string | undefined;
  let picked: ModelChoice | undefined;
  const list = new ListView({
    title: 'Model', theme, root: true, typeToFilter: true, filter, verb: 'select',
    rows: () => (models ? modelRows(models, session.status().model, theme) : []),
    detail: row => {
      const model = models?.find(m => modelRef(m) === row.key);
      return model && `${clean(model.name)}${model.note ? ` · ${clean(model.note)}` : ''}`;
    },
    empty: () => (models || failure ? 'No models.' : 'Loading models…'),
    onOpen: row => {
      const model = models?.find(m => modelRef(m) === row.key);
      if (!model) return;
      if (model.available) { picked = model; frame.close(); return; }
      hint = `${clean(row.key)}: ${clean(model.note ?? 'not available')}`;
      tui.requestRender();
    },
    dispose: session.onStatus(() => tui.requestRender()),
  });
  const frame = new PanelFrame(tui, theme, list, () => {
    if (failure) return theme.error(failure);
    if (hint) return theme.accent(hint);
    const current = `Current: ${clean(session.status().model)}`;
    return theme.dim(tui.terminal.columns < NARROW ? current : `${current} · a new model applies from the next message`);
  });
  session.models().then(
    all => { models = all; tui.requestRender(); },
    (error: unknown) => { failure = `Could not list models: ${error instanceof Error ? error.message : String(error)}`; tui.requestRender(); },
  );
  await openPanel(tui, frame);
  return picked;
}

/**
 * One row per model: the current one first, then available, then unavailable (dim); `provider/id`, name and note.
 * Compact rows keep only the mark and `provider/id`.
 */
export function modelRows(models: readonly ModelChoice[], current: string, theme: PanelTheme): Row[] {
  const rank = (m: ModelChoice): number => (modelRef(m) === current ? 0 : m.available ? 1 : 2);
  const sorted = [...models].sort((a, b) => rank(a) - rank(b));
  const width = Math.max(0, ...sorted.map(m => clean(modelRef(m)).length));
  return sorted.map(m => {
    const mark = modelRef(m) === current ? '✓' : ' ', ref = clean(modelRef(m)).padEnd(width);
    const tail = `${clean(m.name)}${m.note ? ` · ${clean(m.note)}` : ''}`;
    const short = `${mark} ${clean(modelRef(m))}`;
    return {
      key: modelRef(m),
      plain: `${mark} ${ref}  ${tail}`,
      styled: m.available ? `${theme.accent(mark)} ${ref}  ${theme.dim(tail)}` : theme.dim(`${mark} ${ref}  ${tail}`),
      compact: { plain: short, styled: m.available ? `${theme.accent(mark)} ${clean(modelRef(m))}` : theme.dim(short) },
    };
  });
}
