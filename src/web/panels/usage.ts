// Usage (ADR 0039): what the chat spent per model, today, over the last 7 days and all time, a section each. Asked
// for each time the level opens: the server samples the spend for every report, so there is nothing to keep.
import { el } from '../chat-view.ts';
import { costText, USAGE_PERIODS, usageNote, usageSum, usageTokens } from '../../ui/text.ts';
import type { UsageCounts } from '../../ui/text.ts';
import { errorMessage } from '../../protocol/util.ts';
import { RequestError } from '../../protocol/request-error.ts';
import type { UsageReport } from '../../protocol/session.ts';
import { fadeIn, skeletonLines } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

/** One row: who spent, its tokens under it (wrapping on a phone), and the cost aside when there is one. */
function usageRow(label: string, counts: UsageCounts, className = 'usage-row'): HTMLElement {
  const li = el('li');
  const row = el('div', className);
  const text = el('span', 'row-text');
  text.append(el('span', 'row-label', label), el('span', 'row-detail', usageTokens(counts)));
  const cost = costText(counts.cost);
  row.append(text, ...cost ? [el('span', 'row-aside', cost)] : []);
  li.append(row);
  return li;
}

/** A title and a list per period: the sum first when several models spent, then each model. */
function sections(report: UsageReport): HTMLElement[] {
  return USAGE_PERIODS.flatMap(([key, label]) => {
    const rows = report[key];
    const title = el('h3', 'section-title', label);
    if (!rows.length) return [title, el('p', 'sheet-note', 'Nothing yet.')];
    const list = el('ul', 'rows');
    list.append(...rows.length > 1 ? [usageRow('All models', usageSum(rows), 'usage-row usage-total')] : [],
      ...rows.map(row => usageRow(row.model, row)));
    return [title, list];
  });
}

export function usageView(ctx: PanelContext): View {
  let unsubscribe = (): void => undefined;
  return {
    title: 'Usage',
    render(body) {
      const periods = el('div', 'usage');
      periods.append(skeletonLines(6));
      const note = el('p', 'sheet-note');
      note.hidden = true;
      body.append(periods, note);
      /** Set when the load failed as the link was down; it runs again once the link is back. */
      let retry = false;
      const say = (text: string, error = false): void => {
        note.textContent = text;
        note.classList.toggle('is-error', error);
        note.hidden = false;
        fadeIn(note);
      };
      const load = (): void => {
        ctx.link.request('usage', {}).then(
          ({ report }) => {
            periods.replaceChildren(...sections(report));
            fadeIn(periods);
            say(usageNote(report, Date.now()));
          },
          (error: unknown) => {
            retry = error instanceof RequestError && error.code === 'disconnected';
            periods.replaceChildren();
            say(errorMessage(error), true);
          },
        );
      };
      unsubscribe = ctx.store.subscribe(() => { if (retry && ctx.link.state === 'ready') { retry = false; load(); } });
      load();
    },
    dispose() { unsubscribe(); },
  };
}
