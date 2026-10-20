// Chat settings, as Pi Cloud's sheet behind the header's sliders button: the model and reasoning effort as two
// selects, switches for the coding tools and this device's notifications, and rows into Agents and Memory. A model
// or effort applies to Pi and its agents from the next request and is saved as the default; the tools are for this
// server run only, and turning them on asks first.
import { el } from '../chat-view.ts';
import { errorText, memoryHeader, modelRef, sortModels } from '../format.ts';
import { disablePush, enablePush, pushState } from '../push.ts';
import type { PushState } from '../push.ts';
import { agentsView } from './agents.ts';
import { memoryView } from './memory.ts';
import { renderRows } from './sheet.ts';
import type { PanelContext, View } from './sheet.ts';
import { setTools } from './tools.ts';

/** What each effort level means, in a few words. */
export const EFFORT_HINTS: Readonly<Record<string, string>> = {
  off: 'No reasoning', minimal: 'The least reasoning', low: 'Quick answers', medium: 'Balanced',
  high: 'The default', xhigh: 'Harder problems, slower', max: 'The most reasoning, slowest',
};

const PUSH_TEXT: Readonly<Record<PushState, string>> = {
  unsupported: 'This browser cannot show notifications from the server.',
  install: 'On iPhone and iPad, add the app to the Home Screen (Share, Add to Home Screen) and open it from there.',
  'no-key': 'The server has notifications off. They need PI_DURABLE_ORIGIN.',
  denied: 'Blocked for this site. Allow them in the browser settings.',
  off: 'Get one when Pi answers or an agent reports while the app is closed.',
  on: 'On when Pi answers or an agent reports while no app is open.',
};

/** A labelled select, as Pi Cloud's controls. */
function field(label: string): { readonly wrap: HTMLLabelElement; readonly select: HTMLSelectElement } {
  const wrap = el('label', 'control');
  const select = el('select', 'control-select');
  wrap.append(el('span', 'control-label', label), select);
  return { wrap, select };
}

function option(value: string, text: string, disabled = false): HTMLOptionElement {
  const node = el('option', '', text);
  node.value = value;
  node.disabled = disabled;
  return node;
}

/** Sets a select's value; one it does not list (yet) still shows, as a disabled option, rather than a blank. */
function choose(select: HTMLSelectElement, value: string, text = value): void {
  if (value && !Array.from(select.options).some(node => node.value === value)) select.prepend(option(value, text, true));
  select.value = value;
}

/** An effort level with its hint. */
function levelText(level: string): string {
  return EFFORT_HINTS[level] ? `${level} · ${EFFORT_HINTS[level]}` : level;
}

/** A switch row: a title, a line under it, and a switch. */
function switchRow(title: string): { readonly row: HTMLElement; readonly note: HTMLElement; readonly toggle: HTMLButtonElement } {
  const row = el('div', 'switch-row');
  const text = el('div', 'switch-text');
  const note = el('small');
  text.append(el('strong', '', title), note);
  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', title);
  toggle.append(el('span'));
  row.append(text, toggle);
  return { row, note, toggle };
}

export function chatSettingsView(ctx: PanelContext): View {
  let unsubscribe = (): void => undefined;
  return {
    title: 'Chat settings',
    render(body) {
      const controls = el('div', 'controls');
      const model = field('Model');
      const effort = field('Thinking');
      const busyNote = el('p', 'sheet-note', "Changes apply from Pi's next request.");
      busyNote.hidden = true;
      const state = el('p', 'sheet-note');
      state.hidden = true;
      controls.append(model.wrap, effort.wrap);

      const switches = el('div', 'switches');
      const tools = switchRow('Coding tools');
      const push = switchRow('Notifications');
      switches.append(tools.row, push.row);

      const list = el('ul', 'rows rows-settings');
      body.append(controls, busyNote, state, switches, list);

      const say = (text: string, error = false): void => {
        state.hidden = !text;
        state.textContent = text;
        state.classList.toggle('is-error', error);
      };

      // ---------------------------------------------------------- model and effort
      let pending = false;
      const lock = (on: boolean): void => {
        pending = on;
        model.select.disabled = on;
        effort.select.disabled = on;
      };
      let shownModel = '';
      const loadModels = (): void => {
        const current = ctx.store.status?.model ?? '';
        shownModel = current;
        model.select.replaceChildren(option(current, current || 'Loading…'));
        ctx.link.request('models', {}).then(
          ({ models }) => {
            model.select.replaceChildren(...sortModels(models, current).map(m =>
              option(modelRef(m), m.note ? `${m.name} (${m.note})` : m.name, !m.available)));
            choose(model.select, ctx.store.status?.model ?? current);
          },
          (error: unknown) => say(`Could not list models: ${errorText(error)}`, true),
        );
      };
      const loadLevels = (): void => {
        const current = ctx.store.status?.thinkingLevel ?? '';
        effort.select.replaceChildren(option(current, current || 'Loading…'));
        ctx.link.request('thinking.levels', {}).then(
          ({ levels }) => {
            effort.select.replaceChildren(...levels.map(level => option(level, levelText(level))));
            // A level the model does not list (set before a model switch) still shows, as the one in use.
            const now = ctx.store.status?.thinkingLevel ?? current;
            choose(effort.select, now, levelText(now));
          },
          (error: unknown) => say(`Could not list levels: ${errorText(error)}`, true),
        );
      };
      // A status that arrives while a change is pending is drawn once the change settles.
      const settle = (): void => { lock(false); last = ''; draw(); };
      model.select.addEventListener('change', () => {
        const key = model.select.value;
        const [provider = '', ...rest] = key.split('/');
        if (pending || key === ctx.store.status?.model) return;
        lock(true);
        say(`Switching to ${key}…`);
        ctx.link.request('model.set', { provider, id: rest.join('/') }).then(
          () => {
            shownModel = key;
            say('');
            ctx.notice(`Model: ${key} (from the next message; saved as default)`);
            loadLevels();
          },
          (error: unknown) => { choose(model.select, ctx.store.status?.model ?? ''); say(`Model not changed: ${errorText(error)}`, true); },
        ).finally(settle);
      });
      effort.select.addEventListener('change', () => {
        const level = effort.select.value;
        if (pending || level === ctx.store.status?.thinkingLevel) return;
        lock(true);
        say(`Setting ${level}…`);
        ctx.link.request('thinking.set', { level }).then(
          () => { say(''); ctx.notice(`Effort: ${level} (from the next request; saved as default)`); },
          (error: unknown) => {
            const now = ctx.store.status?.thinkingLevel ?? '';
            choose(effort.select, now, levelText(now));
            say(`Effort not changed: ${errorText(error)}`, true);
          },
        ).finally(settle);
      });

      // ---------------------------------------------------------- coding tools
      let toolsBusy = false;
      const drawTools = (): void => {
        const on = ctx.store.status?.toolsEnabled ?? false;
        const policy = ctx.store.welcome?.tools;
        const remoteOff = policy?.remote === 'off';
        tools.toggle.setAttribute('aria-checked', String(on));
        tools.toggle.disabled = toolsBusy || (!on && remoteOff);
        tools.note.textContent = on
          ? `Read, write, edit and bash on the server; the chat's files and credentials stay hidden.${policy?.idleMinutes === undefined ? '' : ` Off after ${policy.idleMinutes} idle minutes.`}`
          : remoteOff ? 'The server keeps them off for the web. Use the terminal: /tools on.' : 'Off: Pi and its agents can only talk.';
      };
      tools.toggle.addEventListener('click', () => {
        toolsBusy = true;
        drawTools();
        void setTools(ctx, !(ctx.store.status?.toolsEnabled ?? false)).finally(() => { toolsBusy = false; drawTools(); });
      });

      // ---------------------------------------------------------- notifications
      let pushNow: PushState = 'unsupported';
      const drawPush = (): void => {
        push.toggle.setAttribute('aria-checked', String(pushNow === 'on'));
        push.toggle.disabled = pushNow !== 'on' && pushNow !== 'off';
        push.note.textContent = PUSH_TEXT[pushNow];
      };
      // An error stays in the note over the refreshed state's text.
      const refreshPush = (error?: string): void => {
        void pushState(ctx.store.welcome?.pushKey).then(next => { pushNow = next; drawPush(); if (error) push.note.textContent = error; });
      };
      push.toggle.addEventListener('click', () => {
        const key = ctx.store.welcome?.pushKey;
        if (!key) return;
        push.toggle.disabled = true;
        // enablePush asks for permission first thing: the prompt must come straight from this tap.
        void (pushNow === 'on' ? disablePush(ctx.link) : enablePush(ctx.link, key)).then(
          () => { ctx.notice(pushNow === 'on' ? 'Notifications off for this device.' : 'Notifications on for this device.'); refreshPush(); },
          (error: unknown) => { push.note.textContent = errorText(error); refreshPush(errorText(error)); },
        );
      });

      // ---------------------------------------------------------- agents and memory
      const drawRows = (): void => {
        const status = ctx.store.status;
        const agents = status?.agents ?? [];
        const busy = agents.filter(agent => agent.busy).length;
        renderRows(list, [
          { key: 'agents', label: 'Agents', detail: agents.length ? `${busy} busy · ${agents.length} in all` : 'None yet', aside: '›' },
          { key: 'memory', label: 'Memory', detail: memoryHeader(status?.memory), aside: '›' },
        ], key => ctx.sheet.push(key === 'agents' ? agentsView(ctx) : memoryView(ctx)));
      };

      let last = '';
      const draw = (): void => {
        if (pending) return;
        const status = ctx.store.status;
        const now = JSON.stringify([status?.model, status?.thinkingLevel, status?.busy, status?.toolsEnabled, status?.agents, status?.memory]);
        if (now === last) return;
        last = now;
        // Another client may switch the model: its levels may differ too.
        if (status && status.model !== shownModel) { loadModels(); loadLevels(); }
        else if (status) choose(effort.select, status.thinkingLevel, levelText(status.thinkingLevel));
        busyNote.hidden = !status?.busy;
        drawTools();
        drawRows();
      };
      loadModels();
      loadLevels();
      refreshPush();
      draw();
      unsubscribe = ctx.store.subscribe(draw);
    },
    dispose() { unsubscribe(); },
  };
}
