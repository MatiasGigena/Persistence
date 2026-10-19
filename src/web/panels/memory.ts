// Memory: Pi's memory view, one row per line. A line zooms into its two halves, and a single message (n = 1) opens
// whole; breadcrumbs lead back up. The top level reloads when the memory's counters change while it is open.
import { el } from '../chat-view.ts';
import { errorText, lineLabel, memoryHeader, parseMessage, parseZoom } from '../format.ts';
import type { ViewLine } from '../../protocol/messages.ts';
import { renderRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

export const LOADING = 'Loading…';

/** A filterable list of view lines; `load` gives them. */
function linesView(ctx: PanelContext, title: string, load: () => Promise<readonly ViewLine[]>, top: boolean): View {
  let unsubscribe = (): void => undefined;
  return {
    title,
    render(body) {
      const header = el('p', 'sheet-note');
      const search = el('input', 'search');
      search.type = 'search';
      search.placeholder = 'Filter lines';
      search.setAttribute('aria-label', 'Filter lines');
      const list = el('ul', 'rows rows-dense');
      const state = el('p', 'sheet-note', LOADING);
      body.append(header, search, list, state);
      let lines: readonly ViewLine[] = [];
      let loading = false, again = false, loaded = false;
      const draw = (): void => {
        const needle = search.value.trim().toLowerCase();
        const shown = needle ? lines.filter(l => `${lineLabel(l)} ${l.text}`.toLowerCase().includes(needle)) : lines;
        renderRows(list, shown.map(line => ({
          key: lineLabel(line), label: line.text, aside: lineLabel(line), className: 'row-line',
        })), key => {
          const line = lines.find(l => lineLabel(l) === key);
          if (line) ctx.sheet.push(line.n > 1 ? zoomView(ctx, line) : messageView(ctx, line));
        });
        if (loaded) state.textContent = shown.length ? '' : lines.length ? 'No line matches.' : !top ? 'Nothing under this line.'
          : ctx.store.status?.memory ? 'Memory is empty.' : 'Memory is off.';
        state.hidden = !state.textContent;
        search.hidden = lines.length < 8;
      };
      const reload = (): void => {
        if (loading) { again = true; return; }
        loading = true;
        load().then(
          next => { lines = next; loaded = true; },
          (error: unknown) => { if (!loaded) state.textContent = errorText(error); },
        ).finally(() => {
          loading = false;
          draw();
          if (top) list.lastElementChild?.scrollIntoView({ block: 'end' });
          if (again) { again = false; reload(); }
        });
      };
      search.addEventListener('input', draw);
      if (top) {
        let shownMemory = JSON.stringify(ctx.store.status?.memory ?? null);
        header.textContent = memoryHeader(ctx.store.status?.memory);
        unsubscribe = ctx.store.subscribe(() => {
          const memory = JSON.stringify(ctx.store.status?.memory ?? null);
          if (memory === shownMemory) return;
          shownMemory = memory;
          header.textContent = memoryHeader(ctx.store.status?.memory);
          reload();
        });
      } else header.textContent = 'Each line opens into the two lines under it.';
      reload();
    },
    dispose() { unsubscribe(); },
  };
}

export function memoryView(ctx: PanelContext): View {
  return linesView(ctx, 'Memory', () => ctx.link.request('memory.view', {}).then(r => r.lines), true);
}

function zoomView(ctx: PanelContext, line: ViewLine): View {
  return linesView(ctx, lineLabel(line), () => ctx.link.request('memory.zoom', { id: line.id, n: line.n }).then(r => parseZoom(r.text)), false);
}

/** One message, whole. */
function messageView(ctx: PanelContext, line: ViewLine): View {
  return {
    title: lineLabel(line),
    render(body) {
      const note = el('p', 'sheet-note', LOADING);
      const text = el('div', 'message-text');
      body.append(note, text);
      ctx.link.request('memory.zoom', { id: line.id, n: line.n }).then(
        ({ text: out }) => {
          const { note: page, body: message } = parseMessage(out);
          note.textContent = page ?? '';
          note.hidden = !page;
          text.textContent = message;
        },
        (error: unknown) => { note.textContent = errorText(error); note.classList.add('is-error'); },
      );
    },
  };
}
