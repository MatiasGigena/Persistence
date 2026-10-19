// /mem: a browser over Pi's memory view. Each line zooms into its two halves, and a single
// message (n = 1) opens whole; Esc climbs back up the breadcrumbs.
import type { TUI } from '@earendil-works/pi-tui';
import { NARROW } from '../theme.ts';
import type { MemoryStatus } from '../../../memory/index.ts';
import type { UiSession, ViewLine } from '../../types.ts';
import { clean, ListView, openPanel, PanelFrame, TextView, wrap } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';

/** Opens the memory panel over the chat; resolves when it closes and the editor has focus again. */
export function openMemoryPanel(tui: TUI, session: UiSession, theme: PanelTheme): Promise<void> {
  const root = level('Memory', () => session.memoryView(), true, session.onStatus(() => tui.requestRender()));
  const frame = new PanelFrame(tui, theme, root, () => memoryHeader(session.status().memory, theme, tui.terminal.columns < NARROW));

  function level(title: string, lines: () => readonly ViewLine[], top: boolean, dispose?: () => void): ListView {
    const byKey = new Map<string, ViewLine>();
    return new ListView({
      title, theme, root: top, followEnd: top, filterable: true, dispose,
      rows: () => { const all = lines(); byKey.clear(); for (const l of all) byKey.set(label(l), l); return viewRows(all, theme); },
      empty: () => (session.status().memory ? 'Memory is empty.' : 'Memory is off.'),
      onOpen: row => { const line = byKey.get(row.key); if (line) open(line); },
      detail: row => { const line = byKey.get(row.key); return line && clean(line.text); },
    });
  }

  function open(line: ViewLine): void {
    let out: string;
    try { out = session.zoom(line.id, line.n); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      frame.push(new TextView({ title: label(line), lines: width => wrap(message, width).map(theme.error) }));
      return;
    }
    if (line.n === 1) {
      const { note, body } = parseMessage(out);
      frame.push(new TextView({ title: label(line), lines: width => [...(note ? [theme.dim(note)] : []), ...wrap(body, width)] }));
      return;
    }
    const children = parseZoom(out);
    frame.push(level(label(line), () => children, false));
  }

  return openPanel(tui, frame);
}

const label = (line: ViewLine): string => `${line.id}+${line.n}`;

/** Messages, view size, summaries in flight, and failures; `narrow` abbreviates them. */
export function memoryHeader(memory: MemoryStatus | undefined, theme: PanelTheme, narrow = false): string {
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
