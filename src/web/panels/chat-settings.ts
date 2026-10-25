// Chat settings, as Pi Cloud's sheet behind the header's sliders button: the model and reasoning effort as two
// selects, switches for the coding tools and this device's notifications, and rows into Agents and Memory. A model
// or effort applies to Pi and its agents from the next request and is saved as the default; the tools are for this
// server run only, and turning them on asks first.
import { el } from '../chat-view.ts';
import { errorText, memoryHeader, modelRef, sortModels } from '../format.ts';
import { disablePush, enablePush, pushState } from '../push.ts';
import type { PushState } from '../push.ts';
import type { ModelChoice } from '../../protocol/messages.ts';
import { agentsView } from './agents.ts';
import { memoryView } from './memory.ts';
import { fadeIn, renderRows } from './sheet.ts';
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

/** One entry of a select. */
interface Choice { readonly value: string; readonly text: string; readonly disabled?: boolean }

/**
 * The lists last loaded, kept across openings of the sheet: a select shows them at once and the fresh list, asked
 * for in the background, replaces them only if it differs. Levels are per model.
 */
let modelsCache: readonly ModelChoice[] | undefined;
const levelsCache = new Map<string, readonly string[]>();

/** A labelled select, as Pi Cloud's controls; a skeleton holds its place until its list is known. */
interface Field {
  readonly wrap: HTMLLabelElement;
  readonly select: HTMLSelectElement;
  /** Whether the select shows (a list came, or the list failed and it shows the current value alone). */
  readonly ready: boolean;
  /**
   * Lists `choices` with `value` chosen. An unchanged list leaves the options alone; a changed one that comes while
   * the user is choosing (the select focused, or a change pending) waits for `resume`.
   */
  fill(choices: readonly Choice[], value: string, text?: string): void;
  /** Swaps the skeleton for the select, fading it in. */
  reveal(): void;
  /** Applies a list that waited, keeping the value chosen. */
  resume(): void;
}

function field(label: string, held: () => boolean): Field {
  const wrap = el('label', 'control');
  const select = el('select', 'control-select');
  const skeleton = el('span', 'control-skeleton skeleton');
  skeleton.setAttribute('aria-hidden', 'true');
  select.hidden = true;
  wrap.setAttribute('aria-busy', 'true');
  wrap.append(el('span', 'control-label', label), skeleton, select);
  let listed: string | undefined;
  let waiting: readonly Choice[] | undefined;
  const list = (choices: readonly Choice[]): void => {
    const key = JSON.stringify(choices);
    if (key === listed) return;
    listed = key;
    select.replaceChildren(...choices.map(c => option(c.value, c.text, c.disabled)));
  };
  const self: Field = {
    wrap,
    select,
    get ready() { return !select.hidden; },
    fill(choices, value, text) {
      if (self.ready && (held() || document.activeElement === select)) { waiting = choices; return; }
      waiting = undefined;
      list(choices);
      choose(select, value, text);
      self.reveal();
    },
    reveal() {
      if (self.ready) return;
      skeleton.remove();
      select.hidden = false;
      wrap.removeAttribute('aria-busy');
      fadeIn(select);
    },
    resume() {
      if (!waiting || held()) return;
      const keep = select.value;
      list(waiting);
      waiting = undefined;
      choose(select, keep);
    },
  };
  select.addEventListener('blur', () => self.resume());
  return self;
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

function modelChoices(models: readonly ModelChoice[], current: string): Choice[] {
  return sortModels(models, current).map(m => ({ value: modelRef(m), text: m.note ? `${m.name} (${m.note})` : m.name, disabled: !m.available }));
}

function levelChoices(levels: readonly string[]): Choice[] {
  return levels.map(level => ({ value: level, text: levelText(level) }));
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
      let pending = false;
      const model = field('Model', () => pending);
      const effort = field('Thinking', () => pending);
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

      // `busy` puts a spinner before the text: a change in flight.
      const say = (text: string, error = false, busy = false): void => {
        state.hidden = !text;
        state.replaceChildren(...(busy ? [el('span', 'spinner')] : []), text);
        state.classList.toggle('is-error', error);
        state.classList.toggle('is-busy', busy);
      };

      // ---------------------------------------------------------- model and effort
      const lock = (on: boolean): void => {
        pending = on;
        model.select.disabled = on;
        effort.select.disabled = on;
      };
      let shownModel = '';
      const loadModels = (): void => {
        const current = ctx.store.status?.model ?? '';
        shownModel = current;
        if (modelsCache) model.fill(modelChoices(modelsCache, current), current);
        ctx.link.request('models', {}).then(
          ({ models }) => {
            modelsCache = models;
            model.fill(modelChoices(models, current), ctx.store.status?.model ?? current);
          },
          (error: unknown) => {
            if (!model.ready) { choose(model.select, current); model.reveal(); }
            say(`Could not list models: ${errorText(error)}`, true);
          },
        );
      };
      const loadLevels = (): void => {
        const current = ctx.store.status?.thinkingLevel ?? '';
        // Levels are the model's: the one just chosen here, or the status's.
        const forModel = shownModel;
        const cached = levelsCache.get(forModel);
        if (cached) effort.fill(levelChoices(cached), current, levelText(current));
        ctx.link.request('thinking.levels', {}).then(
          ({ levels }) => {
            levelsCache.set(forModel, levels);
            // A level the model does not list (set before a model switch) still shows, as the one in use.
            const now = ctx.store.status?.thinkingLevel ?? current;
            effort.fill(levelChoices(levels), now, levelText(now));
          },
          (error: unknown) => {
            if (!effort.ready) { choose(effort.select, current, levelText(current)); effort.reveal(); }
            say(`Could not list levels: ${errorText(error)}`, true);
          },
        );
      };
      // A status that arrives while a change is pending is drawn once the change settles.
      const settle = (): void => { lock(false); model.resume(); effort.resume(); last = ''; draw(); };
      model.select.addEventListener('change', () => {
        const key = model.select.value;
        const [provider = '', ...rest] = key.split('/');
        if (pending || key === ctx.store.status?.model) return;
        lock(true);
        say(`Switching to ${key}…`, false, true);
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
        say(`Setting ${level}…`, false, true);
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
        tools.toggle.setAttribute('aria-busy', String(toolsBusy));
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
