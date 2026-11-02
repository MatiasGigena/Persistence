// Agents: the live list from the status, and each agent's conversation as a read-only feed (`feed.open`).
import { ChatView, el } from '../chat-view.ts';
import { errorText } from '../format.ts';
import { RequestError } from '../link.ts';
import { fadeIn, renderRows, skeletonLines, skeletonRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';

export const NO_AGENTS = 'No agents yet. Ask Pi to spawn one.';

export function agentsView(ctx: PanelContext): View {
  let unsubscribe = (): void => undefined;
  return {
    title: 'Agents',
    render(body) {
      const list = el('ul', 'rows');
      const empty = el('p', 'sheet-note', NO_AGENTS);
      const note = el('p', 'sheet-note', 'Tap an agent to read its conversation.');
      body.append(note, list, empty);
      // Rows known when the level opens ride in with it; rows that wait for the first status stagger in.
      let entered = ctx.store.status !== undefined;
      const draw = (): void => {
        const status = ctx.store.status;
        if (!status) {
          note.hidden = empty.hidden = true;
          skeletonRows(list, 3, { mark: true, detail: true });
          return;
        }
        const agents = status.agents;
        empty.hidden = agents.length > 0;
        note.hidden = agents.length === 0;
        renderRows(list, agents.map(agent => ({
          key: agent.name,
          label: agent.name,
          detail: agent.role === 'main' ? `main agent of ${agent.parent}` : `sub agent of ${agent.parent}`,
          aside: agent.busy ? 'busy' : 'idle',
          mark: agent.busy ? 'busy' : 'idle',
        })), name => ctx.sheet.push(agentChatView(ctx, name)), entered ? undefined : 'top');
        if (!entered) { entered = true; fadeIn(note); fadeIn(empty); }
      };
      draw();
      // Redraw only when the agents changed, not on every status (busy, memory) update.
      let shown = JSON.stringify(ctx.store.status?.agents ?? null);
      unsubscribe = ctx.store.subscribe(() => {
        const now = JSON.stringify(ctx.store.status?.agents ?? null);
        if (now !== shown) { shown = now; draw(); }
      });
    },
    dispose() { unsubscribe(); },
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
            stopError = `Stop failed: ${errorText(error)}`;
            ctx.notice(stopError, 'error');
          },
        ).finally(() => { stop.disabled = false; draw(); });
      });
      bar.append(state, stop);
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
            state.textContent = errorText(error);
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
        state.textContent = found?.agent.ended ?? (stopError || (found && !found.feed ? 'Reconnecting…' : agent ? (agent.busy ? 'Working' : 'Idle') : ''));
        state.classList.toggle('is-error', Boolean(stopError) && found?.agent.ended === undefined);
        stop.hidden = !agent || found?.agent.ended !== undefined;
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
