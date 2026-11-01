// /effort: the reasoning effort picker, like /model. The current model's levels, lowest first; the current one is
// marked ✓.
import type { TUI } from '@earendil-works/pi-tui';
import type { UiSession } from '../../types.ts';
import { clean, ListView, openPanel, PanelFrame } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';

/** What each level means, in a few words. */
const HINTS: Readonly<Record<string, string>> = {
  off: 'no reasoning', minimal: 'the least reasoning', low: 'quick answers', medium: 'balanced',
  high: 'the default', xhigh: 'harder problems, slower', max: 'the most reasoning, slowest',
};

/**
 * Opens the picker over the chat. Resolves, once it has closed and the editor has focus again, with the level chosen
 * with Enter, or undefined after Esc. Setting it is the caller's job.
 */
export async function openEffortPanel(tui: TUI, session: UiSession, theme: PanelTheme): Promise<string | undefined> {
  let levels: readonly string[] | undefined, failure: string | undefined, picked: string | undefined;
  const list = new ListView({
    title: 'Effort', theme, root: true, verb: 'select', selected: session.status().thinkingLevel,
    rows: () => (levels ? effortRows(levels, session.status().thinkingLevel, theme) : []),
    detail: row => HINTS[row.key],
    empty: () => (levels || failure ? 'No levels.' : 'Loading levels…'),
    onOpen: row => { picked = row.key; frame.close(); },
    dispose: session.onStatus(() => tui.requestRender()),
  });
  const frame = new PanelFrame(tui, theme, list, () => failure ? theme.error(failure)
    : theme.dim(`${clean(session.status().model)} · effort ${clean(session.status().thinkingLevel)} · applies from the next request`));
  session.thinkingLevels().then(
    all => { levels = all; tui.requestRender(); },
    (error: unknown) => { failure = `Could not list levels: ${error instanceof Error ? error.message : String(error)}`; tui.requestRender(); },
  );
  await openPanel(tui, frame);
  return picked;
}

/** One row per level, lowest first; the current one marked ✓. */
export function effortRows(levels: readonly string[], current: string, theme: PanelTheme): Row[] {
  const width = Math.max(0, ...levels.map(level => level.length));
  return levels.map(level => {
    const mark = level === current ? '✓' : ' ', hint = HINTS[level] ?? '';
    const short = `${mark} ${clean(level)}`;
    return {
      key: level,
      plain: `${mark} ${clean(level).padEnd(width)}  ${hint}`,
      styled: `${theme.accent(mark)} ${clean(level).padEnd(width)}  ${theme.dim(hint)}`,
      compact: { plain: short, styled: `${theme.accent(mark)} ${clean(level)}` },
    };
  });
}
