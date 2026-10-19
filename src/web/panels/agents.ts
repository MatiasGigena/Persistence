// Agents: the live list from the status, and each agent's conversation as a read-only feed (`feed.open`).
import { ChatView, el } from '../chat-view.ts';
import { errorText } from '../format.ts';
import { renderRows } from './sheet.ts';
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
      const draw = (): void => {
        const agents = ctx.store.status?.agents ?? [];
        empty.hidden = agents.length > 0;
        note.hidden = agents.length === 0;
        renderRows(list, agents.map(agent => ({
          key: agent.name,
          label: agent.name,
          detail: agent.role === 'main' ? `main agent of ${agent.parent}` : `sub agent of ${agent.parent}`,
          aside: agent.busy ? 'busy' : 'idle',
          mark: agent.busy ? 'busy' : 'idle',
        })), name => ctx.sheet.push(agentChatView(ctx, name)));
      };
      draw();
      // Redraw only when the agents changed, not on every status (busy, memory) update.
      let shown = JSON.stringify(ctx.store.status?.agents ?? []);
      unsubscribe = ctx.store.subscribe(() => {
        const now = JSON.stringify(ctx.store.status?.agents ?? []);
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
      const state = el('p', 'sheet-note', 'Opening…');
      const stop = el('button', 'btn btn-quiet', `Stop ${name}`);
      stop.type = 'button';
      stop.addEventListener('click', () => {
        stop.disabled = true;
        ctx.link.request('stopAgents', { name }).then(
          ({ names }) => ctx.notice(names.length ? `Stopped ${names.join(', ')}.` : `No agent named ${name}.`),
          (error: unknown) => ctx.notice(`Stop failed: ${errorText(error)}`, 'error'),
        ).finally(() => { stop.disabled = false; });
      });
      bar.append(state, stop);
      const scroller = el('div', 'agent-chat');
      const list = el('ol', 'feed feed-agent');
      list.setAttribute('aria-label', `${name}'s conversation`);
      scroller.append(list);
      body.append(bar, scroller);
      view = new ChatView(list, scroller, { empty: 'Nothing here yet.' });
      const draw = (): void => {
        const found = ctx.store.agentByName(name);
        if (found) view?.set(found.agent.mirror.items);
        const agent = ctx.store.status?.agents.find(a => a.name === name);
        state.textContent = found?.agent.ended ?? (found && !found.feed ? 'Reconnecting…' : agent ? (agent.busy ? 'Working' : 'Idle') : '');
        stop.hidden = !agent || found?.agent.ended !== undefined;
      };
      unsubscribe = ctx.store.subscribe(draw);
      ctx.link.request('feed.open', { name }).then(
        ({ feed }) => {
          if (!open) { void ctx.link.request('feed.close', { feed }).catch(() => undefined); return; }
          ctx.store.openAgent(feed, name);
        },
        (error: unknown) => { state.textContent = errorText(error); },
      );
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
