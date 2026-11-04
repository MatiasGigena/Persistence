// Agents: the live list from the status, and each agent's conversation as a read-only feed (`feed.open`). Agents can
// be archived (ADR 0034): one from its conversation, or every ad-hoc one from the list, after a confirmation; the
// list's "Archived" section shows when each is deleted and restores it.
import { ChatView, el } from '../chat-view.ts';
import { activeAgents, adhocAgents, archiveAdhocQuestion, archivedAgents, archivedText, archiveQuestion, deletionText } from '../format.ts';
import { errorMessage } from '../../protocol/util.ts';
import { RequestError } from '../link.ts';
import { byId, fadeIn, renderRows, skeletonLines, skeletonRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

export const NO_AGENTS = 'No agents yet. Ask Pi to spawn one.';
/** Deletion times are redrawn this often while the list is open. */
const CLOCK_MS = 60_000;

/** Asks `question` in the archive dialog; resolves true for "Archive". */
export function confirmArchive(question: string): Promise<boolean> {
  const dialog = byId('agents-confirm', HTMLDialogElement);
  byId('agents-confirm-text', HTMLParagraphElement).textContent = question;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'archive'), { once: true }));
}

/** Archives one agent (with its subs) after asking; says the outcome in the chat, and a refusal in `say`. */
async function archiveOne(ctx: PanelContext, name: string, say: (text: string, error?: boolean) => void): Promise<void> {
  const subs = activeAgents(ctx.store.status?.agents ?? []).filter(a => a.role === 'sub' && a.parent === name).map(a => a.name);
  if (!await confirmArchive(archiveQuestion(name, subs))) return;
  try {
    const { names } = await ctx.link.request('agents.archive', { name });
    ctx.notice(archivedText(names));
    say('');
  } catch (error) {
    say(errorMessage(error), true);
  }
}

async function restore(ctx: PanelContext, name: string, say: (text: string, error?: boolean) => void): Promise<void> {
  try {
    const { names } = await ctx.link.request('agents.restore', { name });
    ctx.notice(archivedText(names, true));
    say('');
  } catch (error) {
    say(errorMessage(error), true);
  }
}

export function agentsView(ctx: PanelContext): View {
  let unsubscribe = (): void => undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  return {
    title: 'Agents',
    render(body) {
      const list = el('ul', 'rows');
      const empty = el('p', 'sheet-note', NO_AGENTS);
      const note = el('p', 'sheet-note', 'Tap an agent to read its conversation, and to stop or archive it.');
      const actions = el('div', 'agents-actions');
      const adhoc = el('button', 'btn', 'Archive all ad-hoc agents');
      adhoc.type = 'button';
      actions.append(adhoc);
      const state = el('p', 'sheet-note');
      state.hidden = true;
      const archivedTitle = el('h3', 'section-title', 'Archived');
      const archivedNote = el('p', 'sheet-note', 'Deleted a day after archiving. Restoring keeps the chat; stopped work stays stopped.');
      const archivedList = el('ul', 'rows');
      body.append(note, list, empty, actions, state, archivedTitle, archivedNote, archivedList);

      const say = (text: string, error = false): void => {
        state.hidden = !text;
        state.textContent = text;
        state.classList.toggle('is-error', error);
      };
      let pending = false;
      const run = (work: Promise<void>): void => {
        pending = true;
        draw();
        void work.finally(() => { pending = false; draw(); });
      };
      adhoc.addEventListener('click', () => {
        const names = adhocAgents(ctx.store.status?.agents ?? []).map(a => a.name);
        if (pending || !names.length) return;
        run(confirmArchive(archiveAdhocQuestion(names)).then(async yes => {
          if (!yes) return;
          try {
            const result = await ctx.link.request('agents.archive', { adhoc: true });
            ctx.notice(archivedText(result.names));
            say('');
          } catch (error) {
            say(errorMessage(error), true);
          }
        }));
      });

      // Rows known when the level opens ride in with it; rows that wait for the first status stagger in.
      let entered = ctx.store.status !== undefined;
      const draw = (): void => {
        const status = ctx.store.status;
        if (!status) {
          note.hidden = empty.hidden = actions.hidden = true;
          archivedTitle.hidden = archivedNote.hidden = archivedList.hidden = true;
          skeletonRows(list, 3, { mark: true, detail: true });
          return;
        }
        const all = status.agents;
        const agents = activeAgents(all), archived = archivedAgents(all), now = Date.now();
        empty.hidden = agents.length > 0;
        note.hidden = agents.length === 0;
        actions.hidden = adhocAgents(all).length === 0;
        adhoc.disabled = pending;
        renderRows(list, agents.map(agent => ({
          key: agent.name,
          label: agent.name,
          detail: agent.role === 'main' ? `main agent of ${agent.parent}` : `sub agent of ${agent.parent}`,
          aside: agent.busy ? 'busy' : 'idle',
          mark: agent.busy ? 'busy' : 'idle',
        })), name => ctx.sheet.push(agentChatView(ctx, name)), entered ? undefined : 'top');
        if (!entered) { entered = true; fadeIn(note); fadeIn(empty); }
        archivedTitle.hidden = archivedNote.hidden = archivedList.hidden = archived.length === 0;
        archivedList.replaceChildren(...archived.map(agent => {
          const li = el('li');
          const row = el('div', 'archived-row');
          const text = el('span', 'row-text');
          const role = agent.role === 'main' ? `main agent of ${agent.parent}` : `sub agent of ${agent.parent}`;
          text.append(el('span', 'row-label', agent.name), el('span', 'row-detail', `${role} · ${deletionText(agent.archivedAt, now)}`));
          const button = el('button', 'btn btn-quiet', 'Restore');
          button.type = 'button';
          button.disabled = pending;
          button.setAttribute('aria-label', `Restore ${agent.name}`);
          button.addEventListener('click', () => { if (!pending) run(restore(ctx, agent.name, say)); });
          row.append(text, button);
          li.append(row);
          return li;
        }));
      };
      draw();
      // Redraw only when the agents changed, not on every status (busy, memory) update; and each minute, for the
      // deletion times.
      let shown = JSON.stringify(ctx.store.status?.agents ?? null);
      unsubscribe = ctx.store.subscribe(() => {
        const now = JSON.stringify(ctx.store.status?.agents ?? null);
        if (now !== shown) { shown = now; draw(); }
      });
      clock = setInterval(draw, CLOCK_MS);
    },
    dispose() { unsubscribe(); clearInterval(clock); },
  };
}

/** One agent's conversation, live and read-only. The feed closes when the view leaves. */
export function agentChatView(ctx: PanelContext, name: string): View {
  let open = true;
  let view: ChatView | undefined;
  let unsubscribe = (): void => undefined;
  return {
    title: name,
    render(body) {
      const bar = el('div', 'sheet-actions');
      const state = el('p', 'sheet-note');
      const stop = el('button', 'btn btn-quiet', `Stop ${name}`);
      stop.type = 'button';
      /** Why the last stop failed: shown here too, as the chat's notice is behind the sheet; cleared by the next tap. */
      let stopError = '';
      stop.addEventListener('click', () => {
        stop.disabled = true;
        stopError = '';
        draw();
        ctx.link.request('stopAgents', { name }).then(
          ({ names }) => ctx.notice(names.length ? `Stopped ${names.join(', ')}.` : `No agent named ${name}.`),
          (error: unknown) => {
            stopError = `Stop failed: ${errorMessage(error)}`;
            ctx.notice(stopError, 'error');
          },
        ).finally(() => { stop.disabled = false; draw(); });
      });
      // Archive, or Restore while archived; a refusal (a standing agent) shows in the state line until the next tap.
      const archive = el('button', 'btn btn-quiet', 'Archive');
      archive.type = 'button';
      let archiveError = '';
      const say = (text: string): void => { archiveError = text; draw(); };
      archive.addEventListener('click', () => {
        const archived = ctx.store.status?.agents.find(a => a.name === name)?.archivedAt !== undefined;
        archive.disabled = true;
        archiveError = '';
        draw();
        void (archived ? restore(ctx, name, say) : archiveOne(ctx, name, say)).finally(() => { archive.disabled = false; });
      });
      bar.append(state, stop, archive);
      const scroller = el('div', 'agent-chat');
      const list = el('ol', 'feed feed-agent');
      list.setAttribute('aria-label', `${name}'s conversation`);
      // Until the conversation is known (its snapshot, which follows the feed.open answer), lines shaped as one hold
      // its place under the loading rule; it fades in over them. An empty list is not known to be empty before then.
      /** Set when feed.open failed: the skeleton gives way to the error rather than waiting on. */
      let failed = false;
      const skeleton = skeletonLines(4);
      skeleton.classList.add('feed-skeleton');
      list.hidden = true;
      scroller.append(skeleton, list);
      body.append(bar, scroller);
      view = new ChatView(list, scroller, { empty: 'Nothing here yet.' });
      /** Set when feed.open failed as the link was down; it is asked again once the link is back. */
      let retry = false;
      /** Set while the store tracks this conversation, not ended (open, or detached by a reconnect). */
      let tracked = false;
      const follow = (): void => {
        ctx.link.request('feed.open', { name }).then(
          ({ feed }) => {
            if (!open) { void ctx.link.request('feed.close', { feed }).catch(() => undefined); return; }
            ctx.store.openAgent(feed, name);
            draw();
          },
          (error: unknown) => {
            if (!open) return;
            failed = true;
            draw();
            state.textContent = errorMessage(error);
            retry = error instanceof RequestError && error.code === 'lost';
          },
        );
      };
      const draw = (): void => {
        if (retry && ctx.link.state === 'ready') { retry = false; follow(); }
        const found = ctx.store.agentByName(name);
        // The store let go of it while the sheet is open: reopening it after a reconnect failed (main.ts forgets it).
        // Ask again, so the conversation comes back or the skeleton gives way to that error rather than waiting on.
        if (found) tracked = found.agent.ended === undefined;
        else if (tracked && list.hidden) {
          tracked = false;
          if (ctx.link.state === 'ready') follow(); else retry = true;
        }
        if (found) view?.set(found.agent.mirror.items);
        // A conversation kept from before a reconnect shows at once.
        if (list.hidden && (failed || found?.agent.loaded || found?.agent.ended !== undefined)) {
          skeleton.remove();
          list.hidden = false;
          fadeIn(list);
        }
        const agent = ctx.store.status?.agents.find(a => a.name === name);
        const archived = agent?.archivedAt !== undefined;
        const error = stopError || archiveError;
        state.textContent = found?.agent.ended ?? (error || (found && !found.feed ? 'Reconnecting…'
          : agent ? (archived ? `Archived · ${deletionText(agent.archivedAt ?? 0, Date.now())}` : agent.busy ? 'Working' : 'Idle') : ''));
        state.classList.toggle('is-error', Boolean(error) && found?.agent.ended === undefined);
        stop.hidden = !agent || archived || found?.agent.ended !== undefined;
        archive.hidden = !agent;
        archive.textContent = archived ? 'Restore' : 'Archive';
      };
      unsubscribe = ctx.store.subscribe(draw);
      follow();
      draw();
    },
    dispose() {
      open = false;
      unsubscribe();
      view?.dispose();
      const found = ctx.store.agentByName(name);
      if (found?.feed !== undefined) {
        ctx.store.closeAgent(found.feed);
        if (found.agent.ended === undefined) void ctx.link.request('feed.close', { feed: found.feed }).catch(() => undefined);
      } else ctx.store.forget(name);
    },
  };
}
