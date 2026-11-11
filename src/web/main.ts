// The web app: pairing, the chat, the header and composer, the sheets, and the link to the server. See
// docs/protocol.md for the messages, and ADR 0020 for why this is plain DOM with no build.
import { ChatView, el, play } from './chat-view.ts';
import { announce } from './copy.ts';
import { guessDeviceName, LINK_TEXT, LOAD_QUIET_MS, LOAD_SLOW_MS, loadStep, formatCodeInput, pairErrorText, shortModel, statusParts } from './format.ts';
import { activeAgents } from '../ui/text.ts';
import { errorMessage, isRecord } from '../protocol/util.ts';
import { Link } from './link.ts';
import { RequestError } from '../protocol/request-error.ts';
import { renderMarkdown } from './markdown.ts';
import type { LinkState, SocketEvents, SocketHandle } from './link.ts';
import { agentsView } from './panels/agents.ts';
import { chatSettingsView, prefetchSettings } from './panels/chat-settings.ts';
import { memoryView } from './panels/memory.ts';
import { schedulesView } from './panels/schedules.ts';
import { byId, Sheet } from './panels/sheet.ts';
import type { PanelContext } from './panels/sheet.ts';
import { syncPush } from './push.ts';
import { linkStep } from './link-state.ts';
import { Banner } from './banner.ts';
import { Composer } from './composer.ts';
import { load, save, session } from './storage.ts';
import { freshAlerts, Store } from './store.ts';
import type { Effect } from './store.ts';
import type { NoticeLevel } from '../protocol/session.ts';

const CLIENT = 'web';
/** sessionStorage: the value a reload was last made for, so a reload happens once per new value. */
const RELOAD_KEY = 'pd.reloaded';
/** sessionStorage: how many images a reload for new files dropped, said once the reloaded app is ready. */
const LOST_KEY = 'pd.lost-images';
/** How long a reload for new files waits for the service worker to revalidate them; past it, a later notice reloads. */
const SHELL_REFRESH_MS = 5_000;

// ------------------------------------------------------------------------------------------------ screens

const SCREENS = ['boot', 'pair', 'gone', 'chat'] as const;
type Screen = typeof SCREENS[number];

/** The screen shown, or on its way in. index.html starts on the boot screen. */
let current: Screen = 'boot';
/** Same-document view transitions, where the browser has them; detected once, never assumed. */
const canTransition = typeof document.startViewTransition === 'function';
/** The view transition running, if any. Its incoming picture is live, so a change made meanwhile shows in it. */
let running: ViewTransition | undefined;
/** Without view transitions: how long a screen going out stays over the one coming in (its exit, --t-fast, and a margin). */
const LEAVE_MS = 200;

/** Shows `current` and hides the others; a screen still fading out (no view transitions) hides itself once done. */
function settle(): void {
  for (const name of SCREENS) {
    const screen = byId(`screen-${name}`, HTMLElement);
    if (name === current) {
      screen.classList.remove('screen-leaving');
      screen.hidden = false;
    } else if (!screen.classList.contains('screen-leaving')) screen.hidden = true;
  }
}

/**
 * Makes a change to the page (`update`) as one view transition of `kind` (styles.css, screens): `screen` for a change
 * of screen, `swap` for a skeleton giving way to its content in place. `update` runs exactly once in every case: at
 * once on a hidden page or while another transition runs (it lands in that one's live picture), and also when the
 * browser skips the transition or `update` throws. Call only where `canTransition`.
 */
function transition(kind: 'screen' | 'swap', update: () => void): void {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    update();
  };
  if (running || document.visibilityState !== 'visible') { once(); return; }
  let vt: ViewTransition;
  try { vt = document.startViewTransition(once); } catch { once(); return; }
  const root = document.documentElement;
  running = vt;
  root.dataset.vt = kind;
  // Skipped (another started, the page hid) or failed: `ready` rejects, and the update still runs, if it has not yet.
  void vt.ready.catch(() => undefined);
  void vt.updateCallbackDone.catch(() => undefined);
  void vt.finished.catch(() => undefined).then(() => {
    if (running === vt) {
      running = undefined;
      delete root.dataset.vt;
    }
    once();
    settle();
  });
}

/**
 * Shows one screen, with `update` (what the screen must hold when it is first seen) made in the same step. A change
 * of screen is a page transition: the old screen sinks back a little and fades, quickly, while the new one rises in,
 * already complete. Without view transitions the same two animations run on the screens themselves, the old one kept
 * over the new until its exit ends. The same screen again just runs `update`.
 */
function show(screen: Screen, update: () => void = () => undefined): void {
  if (screen === current) { update(); return; }
  const from = byId(`screen-${current}`, HTMLElement);
  current = screen;
  const change = (): void => { settle(); update(); };
  if (canTransition) { transition('screen', change); return; }
  if (!from.hidden) from.classList.add('screen-leaving');
  change();
  play(byId(`screen-${screen}`, HTMLElement), 'screen-entering');
  setTimeout(() => { from.classList.remove('screen-leaving'); settle(); }, LEAVE_MS);
}

const GONE = {
  forbidden: ['This login is not allowed', 'The server answers only the Tailscale logins listed in PI_DURABLE_ALLOW_LOGIN.'],
  version: ['This app is out of date', 'The server speaks a newer protocol. Reload to get its version of the app.'],
} as const;

function gone(why: keyof typeof GONE): void {
  const [title, text] = GONE[why];
  byId('gone-title', HTMLHeadingElement).textContent = title;
  byId('gone-text', HTMLParagraphElement).textContent = text;
  show('gone');
}

/**
 * Reloads once for `value` (new assets, a new server boot, a protocol change); false when already done. `prepare` runs
 * only when the reload goes ahead.
 */
async function reloadOnce(value: string, prepare: () => void = () => undefined): Promise<boolean> {
  if (load(session, RELOAD_KEY) === value) return false;
  save(session, RELOAD_KEY, value);
  prepare();
  // Let a changed service worker take over first, and have the shell revalidated (its files are served stale while
  // they revalidate, ADR 0032), so the reload gets the new files.
  await navigator.serviceWorker?.getRegistration().then(r => r?.update()).catch(() => undefined);
  await refreshShell();
  location.reload();
  return true;
}

/** Asks the service worker to fetch the app's files again (sw.ts, `refresh`); resolves when it has, or after a while. */
function refreshShell(): Promise<void> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve();
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(resolve, SHELL_REFRESH_MS);
    channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
    worker.postMessage({ t: 'refresh' }, [channel.port2]);
  });
}

// ------------------------------------------------------------------------------------------------ server checks

type Me = { readonly state: 'ok'; readonly device: string } | { readonly state: 'offline' | 'unpaired' | 'forbidden' };

/** `/api/me`: whether this browser is a paired device; asked before every WebSocket (an upgrade cannot say why it failed). */
async function me(): Promise<Me> {
  let response: Response;
  try { response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }); } catch { return { state: 'offline' }; }
  if (response.status === 401) return { state: 'unpaired' };
  if (response.status === 403) return { state: 'forbidden' };
  // Anything else (a 502 from `tailscale serve` while the server restarts): the tailnet is up, so let the socket try.
  if (!response.ok) return { state: 'ok', device: '' };
  const body: unknown = await response.json().catch(() => undefined);
  const device = isRecord(body) && typeof body.device === 'string' ? body.device : '';
  return { state: 'ok', device };
}

function socket(events: SocketEvents): SocketHandle {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', () => events.open());
  ws.addEventListener('message', event => { if (typeof event.data === 'string') events.message(event.data); });
  ws.addEventListener('close', event => events.close(event.code));
  return {
    send: text => { if (ws.readyState === WebSocket.OPEN) ws.send(text); },
    close: (code, reason) => ws.close(code, reason),
  };
}

// ------------------------------------------------------------------------------------------------ pairing

let pairing = false;
/** What the latest `pairScreen` asked for after pairing: the form's listener is added once, so it reads this. */
let afterPairing = (): void => undefined;

/**
 * Shows the pairing screen, saying `why` this device must pair (again) when that is known; `onPaired` runs once this
 * browser holds a device cookie.
 */
function pairScreen(onPaired: () => void, why = ''): void {
  show('pair');
  const error = byId('pair-error', HTMLParagraphElement);
  error.textContent = why;
  afterPairing = onPaired;
  if (pairing) return;
  pairing = true;
  const form = byId('pair-form', HTMLFormElement);
  const code = byId('pair-code', HTMLInputElement);
  const name = byId('pair-name', HTMLInputElement);
  const button = byId('pair-submit', HTMLButtonElement);
  const label = button.textContent;
  if (!name.value) name.value = guessDeviceName(navigator.userAgent);
  /** Shows an error, replaying its entrance each time (the same text twice included). */
  const fail = (text: string): void => {
    error.textContent = text;
    error.classList.remove('is-new');
    error.getBoundingClientRect(); // a style flush, so re-adding the class starts the animation again
    error.classList.add('is-new');
  };
  /** The button while a pairing request is in flight: disabled, busy, with a spinner. */
  const busy = (on: boolean): void => {
    button.disabled = on;
    button.setAttribute('aria-busy', String(on));
    if (!on) { button.textContent = label; return; }
    const spinner = el('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    button.replaceChildren(spinner, 'Pairing…');
  };
  code.addEventListener('input', () => {
    const next = formatCodeInput(code.value);
    if (next !== code.value) code.value = next;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    error.textContent = '';
    error.classList.remove('is-new');
    busy(true);
    fetch('/api/pair', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: formatCodeInput(code.value), name: name.value.trim() }),
    }).then(
      async response => {
        if (response.ok) { code.value = ''; afterPairing(); return; }
        const body: unknown = await response.json().catch(() => undefined);
        fail(pairErrorText(response.status, isRecord(body) ? body.error : undefined));
      },
      () => { fail('Cannot reach the server. Check that Tailscale is connected.'); },
    ).finally(() => busy(false));
  });
}

// ------------------------------------------------------------------------------------------------ the app

function start(): void {
  const store = new Store();
  const jump = byId('jump', HTMLButtonElement);
  const live = byId('live', HTMLDivElement);
  const pulse = byId('pulse', HTMLDivElement);
  const statusLine = byId('status', HTMLDivElement);
  const modelName = byId('model-name', HTMLSpanElement);

  // The jump button stays in the page and comes and goes by class, as a CSS transition: scrolling about the bottom
  // turns it around mid-way instead of restarting it.
  jump.hidden = false;
  const view = new ChatView(byId('feed', HTMLOListElement), byId('scroller', HTMLDivElement), {
    empty: 'This is your one conversation with Pi. It never resets, and Pi remembers it. Write something to begin.',
    onStuck: stuck => { jump.classList.toggle('is-shown', !stuck); },
  });
  // The first load draws nothing until it is whole (reveal): no empty note before the snapshot says so, no history
  // landing ahead of the status.
  view.hold();
  jump.addEventListener('click', () => view.toBottom());

  const notice = (text: string, level: NoticeLevel = 'info'): void => store.notice(text, level);
  let reopen: string[] = [];
  let wasReady = false;
  /** The first `ready` has been shown. Until then the chat is its skeleton (.is-loading) or not shown at all. */
  let loaded = false;
  /** The reason of the server's `bye` since the last `ready`, shown if it ends the link for good. */
  let byeReason = '';
  /** The link is ready: only then is store.status.busy current. */
  let linkReady = false;
  /**
   * Images the reload that started this page dropped (reloadForFiles), said at the first `ready`. Read at once: a page
   * waiting to reload may reconnect meanwhile, and must not take the count meant for its successor.
   */
  let lostImages = Number(load(session, LOST_KEY)) || 0;
  save(session, LOST_KEY, '');

  const link = new Link({
    connect: socket,
    gate: () => me().then(m => m.state),
    client: CLIENT,
    visible: () => document.visibilityState === 'visible',
    onMessage: msg => { for (const effect of store.handle(msg)) void act(effect); },
    onState: state => onState(state),
  });
  const sheet = new Sheet(byId('sheet', HTMLDialogElement));
  const ctx: PanelContext = { store, link, sheet, notice };

  // -------------------------------------------------------------- composer

  const composer = new Composer({
    form: byId('composer', HTMLFormElement), input: byId('input', HTMLTextAreaElement), send: byId('send', HTMLButtonElement),
    attach: byId('attach', HTMLButtonElement), attachFile: byId('attach-file', HTMLInputElement),
    attachments: byId('attachments', HTMLUListElement),
  }, { link, store, view, notice, loaded: () => loaded, linkReady: () => linkReady });

  // -------------------------------------------------------------- header

  byId('settings-button', HTMLButtonElement).addEventListener('click', () => sheet.open(chatSettingsView(ctx)));

  const drawStatus = (): void => {
    const status = store.status;
    if (!status) return;
    modelName.textContent = `${shortModel(status.model)} · ${status.thinkingLevel}`;
    composer.draw();
    pulse.classList.toggle('is-busy', status.busy || activeAgents(status.agents).some(a => a.busy));
    statusLine.replaceChildren(...statusParts(status).map(part => {
      const opens = part.key === 'agents' ? agentsView : part.key === 'memory' || part.key === 'failed' ? memoryView
        : part.key === 'schedules' ? schedulesView : undefined;
      const node = opens ? el('button', `status-part tone-${part.tone}`, part.text) : el('span', `status-part tone-${part.tone}`, part.text);
      if (opens && node instanceof HTMLButtonElement) {
        node.type = 'button';
        node.addEventListener('click', () => sheet.open(opens(ctx)));
      }
      return node;
    }));
  };
  let lastStatus = '';
  /** Notices already read out, or history from the first load. */
  const alerted = new Set<string>();
  store.subscribe(() => {
    const items = store.rootView();
    // Until the link is ready, items come from a snapshot (a first load, a reconnect): history, drawn without entrances.
    view.set(items, linkReady);
    // A failed send or a server warning only shows in the feed: read it out too. The first load's are history.
    const alerts = freshAlerts(items, alerted);
    if (loaded && alerts.length) announce(alerts.join(' '));
    const status = JSON.stringify(store.status ?? null);
    if (status !== lastStatus) { lastStatus = status; drawStatus(); }
  });

  // -------------------------------------------------------------- link

  // A phone that wakes up reconnects in about a second: the banner waits RECONNECT_BANNER_MS, so that is not shown.
  const banner = new Banner(byId('banner', HTMLDivElement), byId('banner-text', HTMLSpanElement), byId('banner-retry', HTMLButtonElement),
    () => link.poke());

  // -------------------------------------------------------------- the first load

  // One reveal: the boot screen stays until the first `ready` (status and history drawn, at the bottom), then gives
  // way to the finished chat. A load that takes longer follows the loading rule (format.ts loadStep): past
  // LOAD_QUIET_MS the chat's skeleton (ghost messages, the header's places held, a composer that takes a draft but
  // does not send), past LOAD_SLOW_MS the banner's line too. The skeleton then crossfades into the content in place.
  // Later reconnects keep the history on screen and never show the skeleton again.

  const app = byId('screen-chat', HTMLElement);
  const feed = byId('feed', HTMLOListElement);
  /** When `/api/me` let the app in: the loading rule counts from here. */
  let loadStart = 0;
  const loadTimers: ReturnType<typeof setTimeout>[] = [];
  /** The chat as its skeleton (index.html starts it .is-loading); the composer sized for a draft kept from before. */
  const showSkeleton = (): void => show('chat', () => composer.autosize());
  /** Applies the loading rule as it stands now: called at its marks and on each change of the link's state. */
  const loading = (): void => {
    const state = link.state;
    if (loaded || state === 'ready' || state === 'closed') return;
    const step = loadStep(performance.now() - loadStart, state);
    if (step.skeleton) showSkeleton();
    // One line at a time: a newer state's text replaces the one shown, never joins it.
    if (step.text && !banner.shows(step.text)) banner.set(step.text, step.retry);
  };
  /** The link is ready: the first time, the chat whole and at once; after that, as it was. */
  const reveal = (): void => {
    for (const timer of loadTimers.splice(0)) clearTimeout(timer);
    if (loaded) { show('chat'); return; }
    loaded = true;
    const fill = (): void => {
      // The chat in the page first (it may still be on its way in), so the history lands scrolled to the bottom.
      settle();
      app.classList.remove('is-loading');
      view.flush();
      composer.autosize();
    };
    if (current !== 'chat') show('chat', fill);
    else if (canTransition) transition('swap', fill);
    else {
      fill();
      for (const node of [feed, modelName, statusLine]) play(node, 'fade-in');
    }
  };

  function onState(state: LinkState): void {
    linkReady = state === 'ready';
    composer.draw();
    const step = linkStep(state, { loaded, wasReady, bannerShown: banner.shown, droppedWith: link.droppedWith, closedBy: link.closedBy, byeReason });
    if (step.disconnect) reopen = [...new Set([...reopen, ...store.disconnect()])];
    wasReady = state === 'ready';
    switch (step.t) {
      case 'hide-banner': banner.set('', false); return;
      case 'loading': loading(); return;
      case 'banner':
        if (step.delayMs) banner.later(step.text, step.retry, step.delayMs);
        else banner.set(step.text, step.retry);
        return;
      case 'pair':
        sheet.close();
        pairScreen(() => location.reload(), step.reason);
        return;
      case 'gone': gone('forbidden'); return;
      case 'reload-version': void reloadOnce('version').then(done => { if (!done) gone('version'); }); return;
      case 'none': return;
    }
  }

  async function act(effect: Effect): Promise<void> {
    switch (effect.t) {
      case 'resync':
        await link.request('feed.resync', { feed: effect.feed }).catch((error: unknown) => {
          // A dropped link gets fresh snapshots on reconnect; any other refusal must not leave the feed frozen.
          if (!(error instanceof RequestError && error.code === 'disconnected')) store.resyncFailed(effect.feed, errorMessage(error));
        });
        return;
      case 'reload':
        await reloadForFiles(`assets:${store.welcome?.assets ?? ''}`);
        return;
      case 'reply': {
        // Announced as plain text: the rendered Markdown's words, not its markup.
        const plain = el('div');
        plain.innerHTML = renderMarkdown(effect.text);
        live.textContent = `${effect.from} replied: ${(plain.textContent ?? '').trim().slice(0, 280)}`;
        return;
      }
      case 'bye':
        byeReason = effect.reason;
        return;
      case 'ready': {
        byeReason = '';
        save(session, RELOAD_KEY, '');
        reveal();
        if (lostImages) {
          const one = lostImages === 1;
          notice(`The app reloaded for an update, and ${one ? 'an image' : `${lostImages} images`} could not be kept; attach ${one ? 'it' : 'them'} again.`, 'warn');
          lostImages = 0;
        }
        composer.resend();
        // Warms Chat settings' lists once the page is idle, so the sheet opens filled.
        prefetchSettings(link, store);
        const names = reopen;
        reopen = [];
        for (const name of names) {
          link.request('feed.open', { name }).then(
            ({ feed }) => { if (store.agentByName(name)) store.openAgent(feed, name); else void link.request('feed.close', { feed }).catch(() => undefined); },
            () => store.forget(name),
          );
        }
        await syncPush(link, store.welcome?.pushKey).catch(() => undefined);
        return;
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    link.visible(visible);
    if (visible) link.poke();
  });
  addEventListener('online', () => link.poke());

  /** Reloads once for `value`, to run new app files. */
  async function reloadForFiles(value: string): Promise<void> {
    // Messages not yet admitted would be lost with the page: they go back into the draft. Their images cannot be kept,
    // nor those attached to the draft: only the text survives a reload, so the reloaded app says how many went.
    const lost = composer.beforeReload();
    await reloadOnce(value, () => save(session, LOST_KEY, lost ? String(lost) : ''));
  }

  // The service worker has a newer set of the app's files than this page runs on (sw.ts, `announce`).
  navigator.serviceWorker?.addEventListener('message', event => {
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null || !('t' in data) || data.t !== 'shell') return;
    if ('version' in data && typeof data.version === 'string') void reloadForFiles(`shell:${data.version}`);
  });

  async function boot(): Promise<void> {
    const state = await me();
    if (state.state === 'unpaired') { pairScreen(() => void boot()); return; }
    if (state.state === 'forbidden') { gone('forbidden'); return; }
    loadStart = performance.now();
    loadTimers.push(setTimeout(loading, LOAD_QUIET_MS), setTimeout(loading, LOAD_SLOW_MS));
    // No tailnet: nothing is coming soon, so the skeleton and the reason show at once.
    if (state.state === 'offline') {
      showSkeleton();
      banner.set(LINK_TEXT.offline.text, LINK_TEXT.offline.retry);
    }
    link.start();
  }
  void boot();
}

// ------------------------------------------------------------------------------------------------ viewport

/**
 * Keeps the app inside the visual viewport, so the on-screen keyboard never covers the composer (iOS does not
 * resize the layout viewport for it). CSSOM writes are allowed by the CSP; style attributes in markup are not.
 */
function fitViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const fit = (): void => {
    root.style.setProperty('--app-height', `${viewport.height}px`);
    root.style.setProperty('--app-top', `${viewport.offsetTop}px`);
  };
  viewport.addEventListener('resize', fit);
  viewport.addEventListener('scroll', fit);
  fit();
}

fitViewport();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.ts', { scope: '/' }).catch(() => undefined);
start();
