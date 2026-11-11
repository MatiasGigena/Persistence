// Schedules: Pi's scheduled wake-ups (ADR 0038), from the status, soonest first. Each can be cancelled; a new one is
// asked of Pi in the chat.
import { el } from '../chat-view.ts';
import { scheduleWhen } from '../../ui/text.ts';
import { errorMessage } from '../../protocol/util.ts';
import { fadeIn, skeletonRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

export const NO_SCHEDULES = 'No schedules. Ask Pi to remind you of something, or to check back on it later.';
/** The times ("today 09:00") are redrawn this often while the list is open. */
const CLOCK_MS = 60_000;

export function schedulesView(ctx: PanelContext): View {
  let unsubscribe = (): void => undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  return {
    title: 'Schedules',
    render(body) {
      const note = el('p', 'sheet-note', 'Messages Pi left itself for later. Each arrives as a new turn, also while you are away.');
      const list = el('ul', 'rows');
      const empty = el('p', 'sheet-note', NO_SCHEDULES);
      const state = el('p', 'sheet-note');
      state.hidden = true;
      body.append(note, list, empty, state);
      const say = (text: string, error = false): void => {
        state.hidden = !text;
        state.textContent = text;
        state.classList.toggle('is-error', error);
      };
      /** The schedules being cancelled: their buttons wait for the answer. */
      const pending = new Set<number>();
      const cancel = (id: number): void => {
        if (pending.has(id)) return;
        pending.add(id);
        draw();
        ctx.link.request('schedule.cancel', { id }).then(
          () => { ctx.notice(`Schedule #${id} cancelled.`); say(''); },
          (error: unknown) => say(`Not cancelled: ${errorMessage(error)}`, true),
        ).finally(() => { pending.delete(id); draw(); });
      };
      let entered = ctx.store.status !== undefined;
      const draw = (): void => {
        const status = ctx.store.status;
        if (!status) {
          note.hidden = empty.hidden = true;
          skeletonRows(list, 2, { detail: true });
          return;
        }
        const schedules = status.schedules ?? [], now = Date.now();
        note.hidden = schedules.length === 0;
        empty.hidden = schedules.length > 0;
        list.removeAttribute('aria-busy');
        list.replaceChildren(...schedules.map(schedule => {
          const li = el('li');
          const row = el('div', 'archived-row schedule-row');
          const text = el('span', 'row-text');
          text.append(el('span', 'row-label', schedule.text), el('span', 'row-detail', `#${schedule.id} · ${scheduleWhen(schedule, now)}`));
          const button = el('button', 'btn btn-quiet', 'Cancel');
          button.type = 'button';
          button.disabled = pending.has(schedule.id);
          button.setAttribute('aria-label', `Cancel schedule ${schedule.id}`);
          button.addEventListener('click', () => cancel(schedule.id));
          row.append(text, button);
          li.append(row);
          return li;
        }));
        if (!entered) { entered = true; fadeIn(note); fadeIn(empty); fadeIn(list); }
      };
      draw();
      // Redraw when the schedules changed, not on every status (busy, memory) update; and each minute, for the times.
      let shown = JSON.stringify(ctx.store.status?.schedules ?? null);
      unsubscribe = ctx.store.subscribe(() => {
        const now = JSON.stringify(ctx.store.status?.schedules ?? null);
        if (now !== shown) { shown = now; draw(); }
      });
      clock = setInterval(draw, CLOCK_MS);
    },
    dispose() { unsubscribe(); clearInterval(clock); },
  };
}
