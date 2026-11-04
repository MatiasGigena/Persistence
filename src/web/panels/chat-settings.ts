// Chat settings, the sheet behind the header's sliders button: the model and reasoning effort as two
// selects, switches for the coding tools and this device's notifications, and rows into Agents and Memory. A model
// or effort applies to Pi and its agents from the next request and is saved as the default; the tools are for this
// server run only, and turning them on asks first.
import { el } from '../chat-view.ts';
import { memoryHeader, sortModels } from '../format.ts';
import { activeAgents, modelRef } from '../../ui/text.ts';
import { errorMessage } from '../../protocol/util.ts';
import { RequestError } from '../link.ts';
import { disablePush, enablePush, pushState } from '../push.ts';
import type { PushState } from '../push.ts';
import type { Link } from '../link.ts';
import type { Store } from '../store.ts';
import type { ModelChoice } from '../../protocol/messages.ts';
import { agentsView } from './agents.ts';
import { Shared } from './cache.ts';
import { memoryView } from './memory.ts';
import { fadeIn, renderRows, SKELETON_WAIT, slowNote } from './sheet.ts';
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
  // The web app runs only with PI_DURABLE_ORIGIN set: no key means push failed to start, and the log says why.
  'no-key': 'Push could not start on the server. Its log says why (journalctl --user -u pi-durable).',
  denied: 'Blocked for this site. Allow them in the browser settings.',
  off: 'Get one when Pi answers or an agent reports while the app is closed.',
  on: 'On when Pi answers or an agent reports while no app is open.',
};

/** One entry of a select. */
interface Choice { readonly value: string; readonly text: string; readonly disabled?: boolean }

/**
 * The lists last loaded, kept across openings of the sheet and warmed before the first (`prefetchSettings`): a select
 * shows them at once and the fresh list, asked for in the background, replaces them only if it differs. Both are asked
 * for by the model in use (its ref, '' before the first status): levels are the model's, and the model list carries
 * the current model, so a switch asks again rather than joining a request from before it.
 */
const modelsCache = new Shared<readonly ModelChoice[]>();
const levelsCache = new Shared<readonly string[]>();

/** The model list, asked for while `model` is in use; joins a request for it in flight. */
function loadModelList(link: Link, model: string): Promise<readonly ModelChoice[]> {
  return modelsCache.load(model, () => link.request('models', {}).then(r => r.models));
}

/**
 * `model`'s effort levels (the server answers for the model in use), joining a request for them in flight. The answer
 * is kept only if `model` is still the status's: one that comes across a switch made elsewhere may be either model's.
 */
function loadLevelList(link: Link, store: Store, model: string): Promise<readonly string[]> {
  return levelsCache.load(model, () => link.request('thinking.levels', {}).then(r => r.levels), () => (store.status?.model ?? '') === model);
}

/** Runs `task` when the page is idle (after the first paint), or shortly where requestIdleCallback is missing (Safari). */
function whenIdle(task: () => void): void {
  if ('requestIdleCallback' in window) requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 300);
}

/** The store `prefetchSettings` follows, so a reconnect does not subscribe it twice. */
let warming: Store | undefined;

/**
 * Warms the Chat settings sheet's lists in the background, once the page is idle, so the sheet opens filled: the
 * model list and the current model's effort levels, and again whenever the status's model changes (levels are per
 * model). It asks only for what is not cached yet: the sheet refreshes its lists itself each time it opens, and a
 * reconnect should not cost the server a listing (which may run the `claude` CLI). Requests are shared with the
 * sheet's own (an open sheet joins them, and its errors show there); failures here are dropped. Call it each time the
 * link is ready.
 */
export function prefetchSettings(link: Link, store: Store): void {
  whenIdle(() => {
    const warm = (): void => {
      const model = store.status?.model ?? '';
      if (!modelsCache.get(model)) void loadModelList(link, model).catch(() => undefined);
      if (!levelsCache.get(model)) void loadLevelList(link, store, model).catch(() => undefined);
    };
    warm();
    if (warming === store) return;
    warming = store;
    let seen = store.status?.model;
    // Subscribed before any sheet opens, so on a switch this asks first and an open sheet's own reload joins it.
    store.subscribe(() => {
      const now = store.status?.model;
      if (now === seen) return;
      seen = now;
      warm();
    });
  });
}

/** A labelled select; a skeleton holds its place until its list is known. */
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
  /**
   * Applies a list and value that waited (a pending change of the user's is redrawn from the status after). `value`,
   * when given, is the one now current and replaces the waiting value, which a change since may have made stale.
   */
  resume(value?: string, text?: string): void;
}

/** `held` says whether a list must wait (a change pending); `onReveal` runs once the select shows. */
function field(label: string, held: () => boolean, onReveal: () => void): Field {
  const wrap = el('label', 'control');
  const select = el('select', 'control-select');
  const skeleton = el('span', `control-skeleton skeleton ${SKELETON_WAIT}`);
  skeleton.setAttribute('aria-hidden', 'true');
  select.hidden = true;
  wrap.setAttribute('aria-busy', 'true');
  wrap.append(el('span', 'control-label', label), skeleton, select);
  let listed: string | undefined;
  let waiting: { choices: readonly Choice[]; value: string; text?: string } | undefined;
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
      if (self.ready && (held() || document.activeElement === select)) { waiting = { choices, value, text }; return; }
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
      onReveal();
    },
    resume(current, currentText) {
      if (!waiting || held()) return;
      const { choices, value, text } = waiting;
      waiting = undefined;
      list(choices);
      if (current === undefined) choose(select, value, text);
      else choose(select, current, currentText);
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
      // Lists not warmed yet: the loading rule's line under the selects, while either still waits.
      const slow = slowNote();
      const shown = (): void => { if (model.ready && effort.ready) slow.remove(); };
      const model = field('Model', () => pending, shown);
      const effort = field('Thinking', () => pending, shown);
      const busyNote = el('p', 'sheet-note', "Changes apply from Pi's next request.");
      busyNote.hidden = true;
      const state = el('p', 'sheet-note');
      state.hidden = true;
      controls.append(model.wrap, effort.wrap, slow);

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
      /** A list was asked for while the link was down: asked again once it is back. */
      let retry = false;
      const lost = (error: unknown): void => { if (error instanceof RequestError && error.code === 'lost') retry = true; };
      const loadModels = (): void => {
        const current = ctx.store.status?.model ?? '';
        shownModel = current;
        const cached = modelsCache.latest;
        if (cached) model.fill(modelChoices(cached, current), current);
        loadModelList(ctx.link, current).then(
          models => model.fill(modelChoices(models, current), ctx.store.status?.model ?? current),
          (error: unknown) => {
            if (!model.ready) { choose(model.select, current); model.reveal(); }
            lost(error);
            say(`Could not list models: ${errorMessage(error)}`, true);
          },
        );
      };
      const loadLevels = (): void => {
        const current = ctx.store.status?.thinkingLevel ?? '';
        // Levels are the model's: the one just chosen here, or the status's.
        const forModel = shownModel;
        const cached = levelsCache.get(forModel);
        if (cached) effort.fill(levelChoices(cached), current, levelText(current));
        loadLevelList(ctx.link, ctx.store, forModel).then(
          levels => {
            // A level the model does not list (set before a model switch) still shows, as the one in use.
            const now = ctx.store.status?.thinkingLevel ?? current;
            effort.fill(levelChoices(levels), now, levelText(now));
          },
          (error: unknown) => {
            if (!effort.ready) { choose(effort.select, current, levelText(current)); effort.reveal(); }
            lost(error);
            say(`Could not list levels: ${errorMessage(error)}`, true);
          },
        );
      };
      // A status that arrives while a change is pending is drawn once the change settles.
      // The model resumes with the one now in use (the switch's, or the status's after a failure), never the value a
      // list that waited carried from before the switch.
      const settle = (): void => { lock(false); model.resume(shownModel); effort.resume(); last = ''; draw(); };
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
          (error: unknown) => {
            shownModel = ctx.store.status?.model ?? '';
            choose(model.select, shownModel);
            say(`Model not changed: ${errorMessage(error)}`, true);
          },
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
            say(`Effort not changed: ${errorMessage(error)}`, true);
          },
        ).finally(settle);
      });

      // ---------------------------------------------------------- coding tools
      let toolsBusy = false;
      /** Why the last switch failed: kept in the note (the chat's notice is behind the sheet) until the next tap. */
      let toolsError = '';
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
        if (toolsError) tools.note.textContent = toolsError;
      };
      tools.toggle.addEventListener('click', () => {
        toolsBusy = true;
        toolsError = '';
        drawTools();
        void setTools(ctx, !(ctx.store.status?.toolsEnabled ?? false)).then(why => { toolsError = why; })
          .finally(() => { toolsBusy = false; drawTools(); });
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
          (error: unknown) => { push.note.textContent = errorMessage(error); refreshPush(errorMessage(error)); },
        );
      });

      // ---------------------------------------------------------- agents and memory
      const drawRows = (): void => {
        const status = ctx.store.status;
        const all = status?.agents ?? [], agents = activeAgents(all), archived = all.length - agents.length;
        const busy = agents.filter(agent => agent.busy).length;
        const detail = `${agents.length ? `${busy} busy · ${agents.length} in all` : 'None at work'}${archived ? ` · ${archived} archived` : ''}`;
        renderRows(list, [
          { key: 'agents', label: 'Agents', detail: all.length ? detail : 'None yet', aside: '›' },
          { key: 'memory', label: 'Memory', detail: memoryHeader(status?.memory), aside: '›' },
        ], key => ctx.sheet.push(key === 'agents' ? agentsView(ctx) : memoryView(ctx)));
      };

      let last = '';
      const draw = (): void => {
        if (pending) return;
        if (retry && ctx.link.state === 'ready') { retry = false; say(''); loadModels(); loadLevels(); }
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
