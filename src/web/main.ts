// The web app: pairing, the chat, the header and composer, the sheets, and the link to the server. See
// docs/protocol.md for the messages, and ADR 0020 for why this is plain DOM with no build.
import { ChatView, el } from './chat-view.ts';
import { errorText, guessDeviceName, normalizeCode, shortModel, statusParts } from './format.ts';
import { Link, RequestError } from './link.ts';
import { renderMarkdown } from './markdown.ts';
import type { LinkState, SocketEvents, SocketHandle } from './link.ts';
import { agentsView } from './panels/agents.ts';
import { memoryView } from './panels/memory.ts';
import { modelView } from './panels/model.ts';
import { settingsView } from './panels/settings.ts';
import { byId, Sheet } from './panels/sheet.ts';
import type { PanelContext } from './panels/sheet.ts';
import { setTools, toolsView } from './panels/tools.ts';
import { syncPush } from './push.ts';
import { Store } from './store.ts';
import type { Effect } from './store.ts';
import type { NoticeLevel } from '../protocol/messages.ts';

const CLIENT = 'web';
const DRAFT_KEY = 'pd.draft';
/** sessionStorage: the value a reload was last made for, so a reload happens once per new value. */
const RELOAD_KEY = 'pd.reloaded';
/** How long the link may be reconnecting before the banner says so. */
const RECONNECT_BANNER_MS = 2_000;

// ------------------------------------------------------------------------------------------------ storage

function load(storage: () => Storage, key: string): string {
  try { return storage().getItem(key) ?? ''; } catch { return ''; }
}
function save(storage: () => Storage, key: string, value: string): void {
  try {
    if (value) storage().setItem(key, value);
    else storage().removeItem(key);
  } catch { /* private mode or full: the draft is a convenience only */ }
}
const local = (): Storage => localStorage;
const session = (): Storage => sessionStorage;

// ------------------------------------------------------------------------------------------------ screens

type Screen = 'boot' | 'pair' | 'gone' | 'chat';

function show(screen: Screen): void {
  for (const name of ['boot', 'pair', 'gone', 'chat'] as const) byId(`screen-${name}`, HTMLElement).hidden = name !== screen;
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

/** Reloads once for `value` (new assets, a new server boot, a protocol change); false when already done. */
async function reloadOnce(value: string): Promise<boolean> {
  if (load(session, RELOAD_KEY) === value) return false;
  save(session, RELOAD_KEY, value);
  // Let a changed service worker take over first, so the reload gets the new files.
  await navigator.serviceWorker?.getRegistration().then(r => r?.update()).catch(() => undefined);
  location.reload();
  return true;
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
  const device = typeof body === 'object' && body !== null && 'device' in body && typeof body.device === 'string' ? body.device : '';
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

const PAIR_ERRORS: Readonly<Record<number, string>> = {
  400: 'That code is not in the right shape: 8 characters, like 7KQ4-M2XD.',
  401: 'That code is wrong or has expired. Run pi-durable serve pair for a new one.',
  409: 'A device with that name is already paired. Pick another name.',
  429: 'Too many tries. Run pi-durable serve pair for a new code.',
};

let pairing = false;

/** Shows the pairing screen; `onPaired` runs once this browser holds a device cookie. */
function pairScreen(onPaired: () => void): void {
  show('pair');
  if (pairing) return;
  pairing = true;
  const form = byId('pair-form', HTMLFormElement);
  const code = byId('pair-code', HTMLInputElement);
  const name = byId('pair-name', HTMLInputElement);
  const error = byId('pair-error', HTMLParagraphElement);
  const button = byId('pair-submit', HTMLButtonElement);
  if (!name.value) name.value = guessDeviceName(navigator.userAgent);
  code.addEventListener('input', () => {
    const next = normalizeCode(code.value);
    if (next !== code.value) code.value = next;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    fetch('/api/pair', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalizeCode(code.value), name: name.value.trim() }),
    }).then(
      response => {
        if (response.ok) { code.value = ''; onPaired(); return; }
        error.textContent = PAIR_ERRORS[response.status] ?? `The server answered ${response.status}. Try again.`;
      },
      () => { error.textContent = 'Cannot reach the server. Check that Tailscale is connected.'; },
    ).finally(() => { button.disabled = false; });
  });
}

// ------------------------------------------------------------------------------------------------ the app

function start(): void {
  const store = new Store();
  const finePointer = matchMedia('(pointer: fine)');
  const input = byId('input', HTMLTextAreaElement);
  const composer = byId('composer', HTMLFormElement);
  const sendButton = byId('send', HTMLButtonElement);
  const stopButton = byId('stop', HTMLButtonElement);
  const banner = byId('banner', HTMLDivElement);
  const bannerText = byId('banner-text', HTMLSpanElement);
  const retry = byId('banner-retry', HTMLButtonElement);
  const jump = byId('jump', HTMLButtonElement);
  const live = byId('live', HTMLDivElement);
  const pulse = byId('pulse', HTMLDivElement);
  const statusLine = byId('status', HTMLDivElement);
  const modelChip = byId('model-chip', HTMLButtonElement);
  const modelName = byId('model-name', HTMLSpanElement);
  const toolsBar = byId('tools-bar', HTMLDivElement);
  const menu = byId('menu', HTMLDialogElement);

  const view = new ChatView(byId('feed', HTMLOListElement), byId('scroller', HTMLDivElement), {
    empty: 'This is your one conversation with Pi. It never resets, and Pi remembers it. Write something to begin.',
    onStuck: stuck => { jump.hidden = stuck; },
  });
  jump.addEventListener('click', () => view.toBottom());

  const notice = (text: string, level: NoticeLevel = 'info'): void => store.notice(text, level);
  let reopen: string[] = [];
  let wasReady = false;

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

  // -------------------------------------------------------------- sending

  /** Sends not yet admitted, by request id: resent with the same id after a reconnect, so Pi gets each once. */
  const outbox = new Map<string, string>();
  const prefix = `web-${Math.random().toString(36).slice(2, 10)}`;
  let counter = 0;
  const deliver = (id: string, text: string): void => {
    link.request('send', { text, requestId: id }).then(
      () => { outbox.delete(id); store.admitPending(id); },
      (error: unknown) => {
        if (error instanceof RequestError && error.code === 'lost') return;
        outbox.delete(id);
        store.dropPending(id);
        if (!input.value) { input.value = text; autosize(); saveDraft(); }
        notice(`Not sent: ${errorText(error)}`, 'error');
      },
    );
  };
  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    const id = `${prefix}-${++counter}`;
    outbox.set(id, text);
    store.addPending(id, text);
    input.value = '';
    autosize();
    saveDraft();
    view.toBottom();
    deliver(id, text);
  };

  // -------------------------------------------------------------- composer

  const autosize = (): void => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    sendButton.disabled = !input.value.trim();
  };
  const saveDraft = (): void => save(local, DRAFT_KEY, input.value);
  input.value = load(local, DRAFT_KEY);
  autosize();
  input.addEventListener('input', () => { autosize(); saveDraft(); });
  // Enter sends only with a keyboard and mouse; on a phone, Enter is a new line and the button sends.
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !finePointer.matches) return;
    event.preventDefault();
    submit();
  });
  composer.addEventListener('submit', event => { event.preventDefault(); submit(); input.focus(); });

  const abort = (): void => { link.request('abort', {}).catch((error: unknown) => notice(`Interrupt failed: ${errorText(error)}`, 'error')); };
  const stopAll = (): void => {
    abort();
    link.request('stopAgents', {}).then(
      ({ names }) => notice(names.length ? `Stopped ${names.join(', ')}.` : 'No agents to stop.'),
      (error: unknown) => notice(`Stop failed: ${errorText(error)}`, 'error'),
    );
  };
  stopButton.addEventListener('click', abort);

  // -------------------------------------------------------------- header and menu

  modelChip.addEventListener('click', () => sheet.open(modelView(ctx)));
  byId('tools-off', HTMLButtonElement).addEventListener('click', () => void setTools(ctx, false));
  byId('menu-button', HTMLButtonElement).addEventListener('click', () => menu.showModal());
  menu.addEventListener('click', event => { if (event.target === menu) menu.close(); });
  const panels = { agents: agentsView, memory: memoryView, model: modelView, tools: toolsView, settings: settingsView } as const;
  for (const button of menu.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    button.addEventListener('click', () => {
      menu.close();
      const action = button.dataset.action ?? '';
      if (action === 'stop-all') stopAll();
      for (const [name, open] of Object.entries(panels)) if (name === action) sheet.open(open(ctx));
    });
  }

  const drawStatus = (): void => {
    const status = store.status;
    if (!status) return;
    modelName.textContent = shortModel(status.model);
    modelChip.setAttribute('aria-label', `Model ${status.model}. Change model`);
    toolsBar.hidden = !status.toolsEnabled;
    document.documentElement.classList.toggle('tools-on', status.toolsEnabled);
    stopButton.hidden = !status.busy;
    pulse.classList.toggle('is-busy', status.busy || status.agents.some(a => a.busy));
    statusLine.replaceChildren(...statusParts(status).map(part => {
      const opens = part.key === 'agents' ? agentsView : part.key === 'memory' || part.key === 'failed' ? memoryView : undefined;
      const node = opens ? el('button', `status-part tone-${part.tone}`, part.text) : el('span', `status-part tone-${part.tone}`, part.text);
      if (opens && node instanceof HTMLButtonElement) {
        node.type = 'button';
        node.addEventListener('click', () => sheet.open(opens(ctx)));
      }
      return node;
    }));
  };
  let lastStatus = '';
  store.subscribe(() => {
    view.set(store.rootView());
    const status = JSON.stringify(store.status ?? null);
    if (status !== lastStatus) { lastStatus = status; drawStatus(); }
  });

  // -------------------------------------------------------------- link

  // A phone that wakes up reconnects in about a second: the banner waits RECONNECT_BANNER_MS, so that is not shown.
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  const setBanner = (text: string, canRetry: boolean): void => {
    clearTimeout(bannerTimer);
    banner.hidden = !text;
    bannerText.textContent = text;
    retry.hidden = !canRetry;
  };
  retry.addEventListener('click', () => link.poke());

  function onState(state: LinkState): void {
    if (state === 'ready') {
      wasReady = true;
      setBanner('', false);
      return;
    }
    if (wasReady && state !== 'closed') reopen = [...new Set([...reopen, ...store.disconnect()])];
    wasReady = false;
    if (state === 'reconnecting') {
      if (banner.hidden) bannerTimer = setTimeout(() => setBanner('Reconnecting…', true), RECONNECT_BANNER_MS);
      else setBanner('Reconnecting…', true);
    }
    else if (state === 'offline') setBanner('Offline. Connect to Tailscale; retrying.', true);
    else if (state === 'closed') {
      const by = link.closedBy;
      if (by === 'unauthorized' || by === 'unpaired') { sheet.close(); pairScreen(() => location.reload()); }
      else if (by === 'forbidden') gone('forbidden');
      else if (by === 'version') void reloadOnce('version').then(done => { if (!done) gone('version'); });
    }
  }

  async function act(effect: Effect): Promise<void> {
    switch (effect.t) {
      case 'resync':
        await link.request('feed.resync', { feed: effect.feed }).catch(() => undefined);
        return;
      case 'reload':
        // Messages not yet admitted would be lost with the page: they go back into the draft.
        if (outbox.size) save(local, DRAFT_KEY, [...outbox.values(), input.value].filter(Boolean).join('\n\n'));
        await reloadOnce(`assets:${store.welcome?.assets ?? ''}`);
        return;
      case 'reply': {
        // Announced as plain text: the rendered Markdown's words, not its markup.
        const plain = el('div');
        plain.innerHTML = renderMarkdown(effect.text);
        live.textContent = `${effect.from} replied: ${(plain.textContent ?? '').trim().slice(0, 280)}`;
        return;
      }
      case 'bye':
        return;
      case 'ready': {
        save(session, RELOAD_KEY, '');
        show('chat');
        for (const [id, text] of outbox) deliver(id, text);
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

  async function boot(): Promise<void> {
    const state = await me();
    if (state.state === 'unpaired') { pairScreen(() => void boot()); return; }
    if (state.state === 'forbidden') { gone('forbidden'); return; }
    show('chat');
    if (state.state === 'offline') setBanner('Offline. Connect to Tailscale; retrying.', true);
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
