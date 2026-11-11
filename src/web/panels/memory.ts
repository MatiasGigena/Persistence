// Memory: Pi's memory view, one row per line. A line zooms into its two halves, and a single message (n = 1) opens
// whole; breadcrumbs lead back up. The top level reloads when the memory's counters change while it is open. Its
// "Search all messages" field searches the log as written (ADR 0040), where "Filter lines" only narrows the lines shown.
import { el } from '../chat-view.ts';
import { lineLabel, memoryHeader } from '../format.ts';
import { hitLabel, parseMessage, parseZoom, SEARCH_HINT, searchHeader } from '../../ui/text.ts';
import { errorMessage } from '../../protocol/util.ts';
import { RequestError } from '../../protocol/request-error.ts';
import { LIMITS } from '../../protocol/messages.ts';
import type { ViewLine } from '../../protocol/session.ts';
import { fadeIn, renderRows, skeletonLines, skeletonRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

/**
 * The top level's lines last loaded, with the memory's counters (status.memory) as they were when asked for. The
 * level opens on them at once while the counters still match, and reloads behind them. Not warmed before the first
 * opening: the view runs to 128 KB, changes with every turn, and would cost a phone that much on each reconnect.
 */
let lastView: { readonly memory: string; readonly lines: readonly ViewLine[] } | undefined;

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
      const find = searchForm(ctx);
      find.hidden = !ctx.store.status?.memory;
      const list = el('ul', 'rows rows-dense');
      const state = el('p', 'sheet-note');
      state.hidden = true;
      // Until the first lines come: rows shaped as lines, and no filter yet.
      search.hidden = true;
      skeletonRows(list, 6);
      body.append(header, ...top ? [find] : [], search, list, state);
      let lines: readonly ViewLine[] = [];
      /** `retry`: the load failed as the link was down; it runs again once the link is back. */
      let loading = false, again = false, loaded = false, entered = false, retry = false;
      const memoryKey = (): string => JSON.stringify(ctx.store.status?.memory ?? null);
      const toEnd = (): void => list.lastElementChild?.scrollIntoView({ block: 'end' });
      const draw = (): void => {
        const needle = search.value.trim().toLowerCase();
        const shown = needle ? lines.filter(l => `${lineLabel(l)} ${l.text}`.toLowerCase().includes(needle)) : lines;
        // The first lines stagger in, from the end at the top level, which opens scrolled to its newest line.
        const enter = entered ? undefined : top ? 'bottom' : 'top';
        entered = true;
        renderRows(list, shown.map(line => ({
          key: lineLabel(line), label: line.text, aside: lineLabel(line), className: 'row-line',
        })), key => {
          const line = lines.find(l => lineLabel(l) === key);
          if (line) ctx.sheet.push(line.n > 1 ? zoomView(ctx, line) : messageView(ctx, line));
        }, enter);
        if (loaded) state.textContent = shown.length ? '' : lines.length ? 'No line matches.' : !top ? 'Nothing under this line.'
          : ctx.store.status?.memory ? 'Memory is empty.' : 'Memory is off.';
        if (state.hidden && state.textContent) fadeIn(state);
        state.hidden = !state.textContent;
        search.hidden = lines.length < 8;
      };
      const reload = (): void => {
        if (loading) { again = true; return; }
        loading = true;
        const asked = memoryKey();
        // Lines the same as those shown (a reload behind lines kept from before) leave the list and its scroll be.
        let same = false;
        load().then(
          next => {
            same = loaded && JSON.stringify(next) === JSON.stringify(lines);
            lines = next;
            loaded = true;
            if (top) lastView = { memory: asked, lines: next };
          },
          // A failed reload keeps the lines shown; with none yet, its error shows instead.
          (error: unknown) => {
            if (error instanceof RequestError && error.code === 'disconnected') retry = true;
            if (loaded) same = true; else state.textContent = errorMessage(error);
          },
        ).finally(() => {
          loading = false;
          if (!same) {
            draw();
            if (top) toEnd();
          }
          if (again) { again = false; reload(); }
        });
      };
      search.addEventListener('input', draw);
      let shownMemory = memoryKey();
      header.textContent = top ? memoryHeader(ctx.store.status?.memory) : 'Each line opens into the two lines under it.';
      unsubscribe = ctx.store.subscribe(() => {
        if (retry && ctx.link.state === 'ready') { retry = false; reload(); return; }
        if (!top) return;
        const memory = memoryKey();
        if (memory === shownMemory) return;
        shownMemory = memory;
        header.textContent = memoryHeader(ctx.store.status?.memory);
        find.hidden = !ctx.store.status?.memory;
        reload();
      });
      // Lines kept from the last opening, the memory unchanged since: shown at once, scrolled to the end once the
      // level is in the sheet (the sheet scrolls a new level to its top first).
      if (top && lastView?.memory === shownMemory) {
        lines = lastView.lines;
        loaded = entered = true;
        draw();
        requestAnimationFrame(toEnd);
      }
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

/** The top level's "Search all messages" field: submitting it opens the messages that hold its words. */
function searchForm(ctx: PanelContext): HTMLFormElement {
  const form = el('form', 'search-form');
  form.setAttribute('role', 'search');
  const input = el('input', 'search');
  input.type = 'search';
  input.placeholder = 'Search all messages';
  input.setAttribute('aria-label', 'Search all messages');
  input.maxLength = LIMITS.searchQuery;
  input.enterKeyHint = 'search';
  const submit = el('button', 'btn btn-quiet', 'Search');
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const query = input.value.trim();
    if (query) ctx.sheet.push(searchView(ctx, query));
  });
  return form;
}

/** The messages that hold `query`'s words, newest first; a row opens its message whole. */
function searchView(ctx: PanelContext, query: string): View {
  let unsubscribe = (): void => undefined;
  return {
    title: 'Search',
    render(body) {
      const header = el('p', 'sheet-note');
      const list = el('ul', 'rows rows-dense');
      const state = el('p', 'sheet-note');
      body.append(header, list, state);
      /** Set when the search failed as the link was down; it runs again once the link is back. */
      let retry = false;
      const load = (): void => {
        header.hidden = state.hidden = true;
        skeletonRows(list, 6, { detail: true });
        ctx.link.request('memory.search', { query }).then(
          ({ hits, total }) => {
            const now = Date.now();
            header.textContent = searchHeader(query, hits.length, total);
            header.hidden = false;
            fadeIn(header);
            renderRows(list, hits.map(hit => ({ key: String(hit.id), label: hit.snippet, detail: hitLabel(hit, now), className: 'row-line' })),
              key => ctx.sheet.push(messageView(ctx, { id: Number(key), n: 1 })), 'top');
            state.textContent = total ? '' : SEARCH_HINT;
            state.classList.remove('is-error');
            state.hidden = total > 0;
          },
          (error: unknown) => {
            retry = error instanceof RequestError && error.code === 'disconnected';
            renderRows(list, [], () => undefined);
            state.textContent = errorMessage(error);
            state.classList.add('is-error');
            state.hidden = false;
            fadeIn(state);
          },
        );
      };
      unsubscribe = ctx.store.subscribe(() => { if (retry && ctx.link.state === 'ready') { retry = false; load(); } });
      load();
    },
    dispose() { unsubscribe(); },
  };
}

/** One message, whole. */
function messageView(ctx: PanelContext, line: Pick<ViewLine, 'id' | 'n'>): View {
  let unsubscribe = (): void => undefined;
  return {
    title: lineLabel(line),
    render(body) {
      const note = el('p', 'sheet-note');
      note.hidden = true;
      const text = el('div', 'message-text');
      text.append(skeletonLines(5));
      body.append(note, text);
      /** Set when the load failed as the link was down; it runs again once the link is back. */
      let retry = false;
      const load = (): void => {
        ctx.link.request('memory.zoom', { id: line.id, n: line.n }).then(
          ({ text: out }) => {
            const { note: page, body: message } = parseMessage(out);
            note.textContent = page ?? '';
            note.hidden = !page;
            note.classList.remove('is-error');
            text.textContent = message;
            fadeIn(note);
            fadeIn(text);
          },
          (error: unknown) => {
            retry = error instanceof RequestError && error.code === 'disconnected';
            text.replaceChildren();
            note.textContent = errorMessage(error);
            note.classList.add('is-error');
            note.hidden = false;
            fadeIn(note);
          },
        );
      };
      unsubscribe = ctx.store.subscribe(() => { if (retry && ctx.link.state === 'ready') { retry = false; load(); } });
      load();
    },
    dispose() { unsubscribe(); },
  };
}
