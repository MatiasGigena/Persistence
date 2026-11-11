// /find: the user's search of the memory's log (ADR 0040). The hits, newest first, each a label and a line around
// the match; Enter opens the message whole, as /mem does, and Esc goes back. The search runs once, when the panel
// opens: messages logged meanwhile show at the next /find. Pi has no part in it: this is the user's reading aid.
import type { TUI } from '@earendil-works/pi-tui';
import type { SearchHit, UiSession } from '../../../protocol/session.ts';
import { hitLabel, SEARCH_HINT, searchHeader } from '../../text.ts';
import { clean, ListView, openPanel, PanelFrame } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';
import { LOADING, messageView, track } from './memory.ts';

/** Opens the search panel on `query` over the chat; resolves when it closes and the editor has focus again. */
export function openFindPanel(tui: TUI, session: UiSession, theme: PanelTheme, query: string, now: () => number = Date.now): Promise<void> {
  const found = track(tui, session.search(query));
  const hits = (): readonly SearchHit[] => { const loaded = found(); return loaded.state === 'done' ? loaded.value.hits : []; };
  const list = new ListView({
    title: 'Find', theme, root: true, filterable: true,
    rows: () => hitRows(hits(), now(), theme),
    empty: () => {
      const loaded = found();
      return loaded.state === 'loading' ? LOADING : loaded.state === 'failed' ? theme.error(loaded.error) : SEARCH_HINT;
    },
    onOpen: row => frame.push(messageView(tui, session, theme, Number(row.key))),
    detail: row => hits().find(hit => String(hit.id) === row.key)?.snippet,
  });
  const frame = new PanelFrame(tui, theme, list, () => {
    const loaded = found();
    return theme.dim(loaded.state === 'done' ? searchHeader(query, loaded.value.hits.length, loaded.value.total) : `Search: ${clean(query)}`);
  });
  return openPanel(tui, frame);
}

/**
 * One row per hit: its label, dim and aligned, then the snippet. Compact rows are the label alone: a narrow screen
 * shows the selected hit's snippet above the hint.
 */
export function hitRows(hits: readonly SearchHit[], now: number, theme: PanelTheme): Row[] {
  const labels = hits.map(hit => clean(hitLabel(hit, now)));
  const w = Math.max(0, ...labels.map(label => label.length));
  return hits.map((hit, n) => {
    const label = labels[n] ?? '', padded = label.padEnd(w), text = clean(hit.snippet);
    return {
      key: String(hit.id), plain: `${padded}  ${text}`, styled: `${theme.dim(padded)}  ${text}`,
      compact: { plain: label, styled: label },
    };
  });
}
