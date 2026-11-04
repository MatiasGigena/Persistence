// /mem: a browser over Pi's memory view. Each line zooms into its two halves, and a single
// message (n = 1) opens whole; Esc climbs back up the breadcrumbs. The view and each zoom load
// asynchronously (the session may be a server's): a level shows "Loading…" until its lines arrive,
// and the top level reloads whenever the memory's status changes while the panel is open.
import type { TUI } from '@earendil-works/pi-tui';
import { NARROW } from '../theme.ts';
import type { MemoryStats, UiSession, ViewLine } from '../../types.ts';
import { clean, ListView, openPanel, PanelFrame, TextView, wrap } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';
import { errorMessage } from '../../../protocol/util.ts';

/** Shown while a level's lines or a message are on their way. */
export const LOADING = 'Loading…';

/** What a level shows: lines, still loading, or why they failed. */
type Loaded<T> = { readonly state: 'loading' } | { readonly state: 'done'; readonly value: T } | { readonly state: 'failed'; readonly error: string };

/** Opens the memory panel over the chat; resolves when it closes and the editor has focus again. */
export function openMemoryPanel(tui: TUI, session: UiSession, theme: PanelTheme): Promise<void> {
  let view: Loaded<readonly ViewLine[]> = { state: 'loading' };
  let open = true, loading = false, again = false;
  let shownMemory = JSON.stringify(session.status().memory ?? null);
  /** Loads the view; a request while one loads reruns it once that ends. The last view stays shown meanwhile. */
  const load = (): void => {
    if (!open) return;
    if (loading) { again = true; return; }
    loading = true;
    session.memoryView().then(
      lines => { view = { state: 'done', value: lines }; },
      (error: unknown) => { if (view.state !== 'done') view = { state: 'failed', error: errorMessage(error) }; },
    ).finally(() => {
      loading = false;
      tui.requestRender();
      if (again) { again = false; load(); }
    });
  };
  const unsubscribe = session.onStatus(() => {
    const memory = JSON.stringify(session.status().memory ?? null);
    if (memory !== shownMemory) { shownMemory = memory; load(); }
    tui.requestRender();
  });
  const root = level('Memory', () => view, true, () => { open = false; unsubscribe(); });
  const frame = new PanelFrame(tui, theme, root, () => memoryHeader(session.status().memory, theme, tui.terminal.columns < NARROW));
  load();

  function level(title: string, lines: () => Loaded<readonly ViewLine[]>, top: boolean, dispose?: () => void): ListView {
    const byKey = new Map<string, ViewLine>();
    return new ListView({
      title, theme, root: top, followEnd: top, filterable: true, dispose,
      rows: () => {
        const loaded = lines(), all = loaded.state === 'done' ? loaded.value : [];
        byKey.clear();
        for (const l of all) byKey.set(label(l), l);
        return viewRows(all, theme);
      },
      empty: () => {
        const loaded = lines();
        if (loaded.state === 'loading') return LOADING;
        if (loaded.state === 'failed') return theme.error(loaded.error);
        return session.status().memory ? 'Memory is empty.' : 'Memory is off.';
      },
      onOpen: row => { const line = byKey.get(row.key); if (line) zoomInto(line); },
      detail: row => { const line = byKey.get(row.key); return line && clean(line.text); },
    });
  }

  /** The state of `promise`, read on every frame; a render follows when it settles. */
  function track<T>(promise: Promise<T>): () => Loaded<T> {
    let loaded: Loaded<T> = { state: 'loading' };
    promise.then(
      value => { loaded = { state: 'done', value }; },
      (error: unknown) => { loaded = { state: 'failed', error: errorMessage(error) }; },
    ).finally(() => tui.requestRender());
    return () => loaded;
  }

  /** Opens a level for `line` at once, showing LOADING until its zoom resolves. */
  function zoomInto(line: ViewLine): void {
    if (line.n > 1) {
      frame.push(level(label(line), track(session.zoom(line.id, line.n).then(parseZoom)), false));
      return;
    }
    const message = track(session.zoom(line.id, line.n));
    frame.push(new TextView({ title: label(line), lines: width => {
      const out = message();
      if (out.state === 'loading') return [theme.dim(LOADING)];
      if (out.state === 'failed') return wrap(out.error, width).map(theme.error);
      const { note, body } = parseMessage(out.value);
      return [...(note ? [theme.dim(note)] : []), ...wrap(body, width)];
    } }));
  }

  return openPanel(tui, frame);
}

const label = (line: ViewLine): string => `${line.id}+${line.n}`;

/** Messages, view size, summaries in flight, and failures; `narrow` abbreviates them. */
export function memoryHeader(memory: MemoryStats | undefined, theme: PanelTheme, narrow = false): string {
  if (!memory) return theme.dim('memory off');
  const failed = `${memory.failed} failed`, kb = (memory.viewBytes / 1024).toFixed(1);
  const text = narrow ? `${memory.messages} msgs · ${kb} KB · ${memory.active} sum · `
    : `${memory.messages} messages · ${kb} KB view · ${memory.active} summarizing · `;
  return theme.dim(text) + (memory.failed > 0 ? theme.error(failed) : theme.dim(failed));
}

/** One row per view line: `id+n` dim and aligned, then its text. */
export function viewRows(lines: readonly ViewLine[], theme: PanelTheme): Row[] {
  const w = Math.max(0, ...lines.map(l => label(l).length));
  return lines.map(l => {
    const name = label(l).padEnd(w), text = clean(l.text);
    return { key: label(l), plain: `${name}  ${text}`, styled: `${theme.dim(name)}  ${text}` };
  });
}

/** The two lines `zoom(id, n > 1)` returns, as `id+n|text`. Lines that do not parse are skipped. */
export function parseZoom(out: string): ViewLine[] {
  return out.split('\n').flatMap(line => {
    const m = /^(\d+)\+(\d+)\|(.*)$/.exec(line);
    return m ? [{ id: Number(m[1]), n: Number(m[2]), text: m[3] ?? '' }] : [];
  });
}

/** `zoom(id, 1)`: `id+1|kind: text`, or `id+1 (page …)|…` for a long message, whose page note is kept. */
export function parseMessage(out: string): { note: string | undefined; body: string } {
  const bar = out.indexOf('|');
  if (bar < 0) return { note: undefined, body: out };
  const head = out.slice(0, bar), paren = head.indexOf(' (');
  return { note: paren < 0 ? undefined : head.slice(paren + 1), body: out.slice(bar + 1) };
}
