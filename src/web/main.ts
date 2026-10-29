// The web app: pairing, the chat, the header and composer, the sheets, and the link to the server. See
// docs/protocol.md for the messages, and ADR 0020 for why this is plain DOM with no build.
import { imageUrl, toChatImage } from './attach.ts';
import { ChatView, el, initViewer, play } from './chat-view.ts';
import { errorText, guessDeviceName, LINK_TEXT, LOAD_QUIET_MS, LOAD_SLOW_MS, loadStep, normalizeCode, pairErrorText, shortModel, statusParts } from './format.ts';
import { Link, RequestError } from './link.ts';
import { renderMarkdown } from './markdown.ts';
import type { LinkState, SocketEvents, SocketHandle } from './link.ts';
import { agentsView } from './panels/agents.ts';
import { chatSettingsView, prefetchSettings } from './panels/chat-settings.ts';
import { memoryView } from './panels/memory.ts';
import { byId, Sheet } from './panels/sheet.ts';
import type { PanelContext } from './panels/sheet.ts';
import { syncPush } from './push.ts';
import { Store } from './store.ts';
import type { Effect } from './store.ts';
import { IMAGE_LIMITS, restoreImages } from '../protocol/images.ts';
import { CloseCode } from '../protocol/messages.ts';
import type { ChatImage, NoticeLevel } from '../protocol/messages.ts';

const CLIENT = 'web';
const RESTARTING = 'The server is restarting; reconnecting…';
const DRAFT_KEY = 'pd.draft';
/** sessionStorage: the value a reload was last made for, so a reload happens once per new value. */
const RELOAD_KEY = 'pd.reloaded';
/** How long the link may be reconnecting before the banner says so. */
const RECONNECT_BANNER_MS = 2_000;
/** How long after a send the button cannot become stop, so a double tap does not abort what it just sent. */
const SEND_HUSH_MS = 600;
/** How long a reload for new files waits for the service worker to revalidate them; past it, a later notice reloads. */
const SHELL_REFRESH_MS = 5_000;

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

/**
 * Makes `nodes` the children of `parent`, in order, moving only what is out of place: a node that stays is never
 * taken out and put back, which would restart its animations (a spinner, an entrance).
 */
function place(parent: HTMLElement, nodes: readonly Node[]): void {
  let at = parent.firstChild;
  for (const node of nodes) {
    if (node === at) at = at.nextSibling;
    else parent.insertBefore(node, at);
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}

/** A short tap of haptic feedback, where the browser has it. */
function buzz(): void {
  if (!('vibrate' in navigator)) return;
  try { navigator.vibrate(8); } catch { /* feedback only */ }
}

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

/** Reloads once for `value` (new assets, a new server boot, a protocol change); false when already done. */
async function reloadOnce(value: string): Promise<boolean> {
  if (load(session, RELOAD_KEY) === value) return false;
  save(session, RELOAD_KEY, value);
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
    const next = normalizeCode(code.value);
    if (next !== code.value) code.value = next;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    error.textContent = '';
    error.classList.remove('is-new');
    busy(true);
    fetch('/api/pair', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalizeCode(code.value), name: name.value.trim() }),
    }).then(
      async response => {
        if (response.ok) { code.value = ''; afterPairing(); return; }
        const body: unknown = await response.json().catch(() => undefined);
        fail(pairErrorText(response.status, typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined));
      },
      () => { fail('Cannot reach the server. Check that Tailscale is connected.'); },
    ).finally(() => busy(false));
  });
}

// ------------------------------------------------------------------------------------------------ the app

function start(): void {
  const store = new Store();
  const finePointer = matchMedia('(pointer: fine)');
  const input = byId('input', HTMLTextAreaElement);
  const composer = byId('composer', HTMLFormElement);
  const sendButton = byId('send', HTMLButtonElement);
  const attachButton = byId('attach', HTMLButtonElement);
  const attachFile = byId('attach-file', HTMLInputElement);
  const attachments = byId('attachments', HTMLUListElement);
  const banner = byId('banner', HTMLDivElement);
  const bannerText = byId('banner-text', HTMLSpanElement);
  const retry = byId('banner-retry', HTMLButtonElement);
  const jump = byId('jump', HTMLButtonElement);
  const live = byId('live', HTMLDivElement);
  const pulse = byId('pulse', HTMLDivElement);
  const statusLine = byId('status', HTMLDivElement);
  const modelName = byId('model-name', HTMLSpanElement);

  // The jump button and the banner stay in the page and come and go by class, as CSS transitions: a quick toggle
  // (scrolling about the bottom, a reconnect that lands at once) turns around mid-way instead of restarting.
  jump.hidden = false;
  banner.hidden = false;
  const view = new ChatView(byId('feed', HTMLOListElement), byId('scroller', HTMLDivElement), {
    empty: 'This is your one conversation with Pi. It never resets, and Pi remembers it. Write something to begin.',
    onStuck: stuck => { jump.classList.toggle('is-shown', !stuck); },
  });
  // The first load draws nothing until it is whole (reveal): no empty note before the snapshot says so, no history
  // landing ahead of the status.
  view.hold();
  jump.addEventListener('click', () => view.toBottom());
  initViewer();

  const notice = (text: string, level: NoticeLevel = 'info'): void => store.notice(text, level);
  let reopen: string[] = [];
  let wasReady = false;
  /** The first `ready` has been shown. Until then the chat is its skeleton (.is-loading) or not shown at all. */
  let loaded = false;
  /** The reason of the server's `bye` since the last `ready`, shown if it ends the link for good. */
  let byeReason = '';
  /** The link is ready: only then is store.status.busy current. */
  let linkReady = false;

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
  const outbox = new Map<string, { readonly text: string; readonly steer: boolean; readonly images: readonly ChatImage[] }>();
  const prefix = `web-${Math.random().toString(36).slice(2, 10)}`;
  let counter = 0;
  const deliver = (id: string, text: string, steer: boolean, images: readonly ChatImage[]): void => {
    link.request('send', { text, requestId: id, ...steer ? { steer } : {}, ...images.length ? { images } : {} }).then(
      () => { outbox.delete(id); store.admitPending(id); drawSend(); },
      (error: unknown) => {
        if (error instanceof RequestError && error.code === 'lost') return;
        outbox.delete(id);
        drawSend();
        store.dropPending(id);
        if (!input.value) { input.value = text; autosize(); saveDraft(); }
        // The images come back too, merged with any attached meanwhile; what does not fit is said, never dropped silently.
        let dropped = 0;
        if (images.length) {
          const restored = restoreImages(attached, images, Math.max(0, IMAGE_LIMITS.perMessage - reading));
          attached = restored.images;
          dropped = restored.dropped;
          drawAttachments();
        }
        notice(`Not sent: ${errorText(error)}`, 'error');
        if (dropped) {
          notice(`${dropped} image${dropped === 1 ? '' : 's'} could not go back into the message (at most ${IMAGE_LIMITS.perMessage}); attach ${dropped === 1 ? 'it' : 'them'} again.`, 'warn');
        }
      },
    );
  };
  /** Pi is working: a message steers it, and the button stops it while the box is empty (as in Pi Cloud). */
  const busy = (): boolean => store.status?.busy ?? false;
  /** An abort is in flight: the stop button is disabled until it settles or Pi goes idle, so it is sent once. */
  let stopping = false;
  /** Set for SEND_HUSH_MS after a send: a second tap then must not land on stop and withdraw what was just sent. */
  let hush: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => {
    stopping = true;
    buzz();
    drawSend();
    link.request('abort', {})
      .catch((error: unknown) => notice(`Interrupt failed: ${errorText(error)}`, 'error'))
      .finally(() => { stopping = false; drawSend(); });
  };
  const submit = (): void => {
    // Before the first load there is nothing to send into: the draft waits in the box (and in storage).
    if (!loaded) return;
    const text = input.value.trim();
    if (!text && !attached.length) {
      if (sendButton.dataset.mode === 'stop' && !sendButton.disabled) abort();
      return;
    }
    buzz();
    clearTimeout(hush);
    hush = setTimeout(() => { hush = undefined; drawSend(); }, SEND_HUSH_MS);
    const id = `${prefix}-${++counter}`;
    const steer = busy();
    const images = attached;
    outbox.set(id, { text, steer, images });
    store.addPending(id, text, steer, images);
    input.value = '';
    attached = [];
    drawAttachments();
    autosize();
    saveDraft();
    view.toBottom();
    deliver(id, text, steer, images);
  };

  // -------------------------------------------------------------- images to send (ADR 0031)

  /** Images attached to the next message: shown as thumbnails over the composer, each with a remove button. */
  let attached: ChatImage[] = [];
  /** Images being read or scaled: the send waits for them. */
  let reading = 0;
  /** Each attached image's tile, kept while it stays attached: a redraw moves tiles, so only a new one pops in. */
  const tiles = new Map<ChatImage, { readonly li: HTMLLIElement; readonly img: HTMLImageElement; readonly remove: HTMLButtonElement }>();
  /** The tile shown while images are read: the shape of the one coming, with a spinner. */
  const readingTile = el('li', 'attachment attachment-reading skeleton');
  readingTile.append(el('span', 'spinner'), el('span', 'sr-only', 'Reading image…'));
  /** `image`'s tile, labelled as the `k`th image. */
  const tile = (image: ChatImage, k: number): HTMLLIElement => {
    const known = tiles.get(image) ?? newTile(image);
    known.img.alt = `Image ${k + 1}`;
    known.remove.setAttribute('aria-label', `Remove image ${k + 1}`);
    return known.li;
  };
  const newTile = (image: ChatImage): { li: HTMLLIElement; img: HTMLImageElement; remove: HTMLButtonElement } => {
    const li = el('li', 'attachment');
    const img = el('img', 'attachment-image');
    img.src = imageUrl(image) ?? '';
    const remove = el('button', 'attachment-remove');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    remove.addEventListener('click', () => {
      attached = attached.filter(each => each !== image);
      drawAttachments();
      input.focus();
    });
    li.append(img, remove);
    play(li, 'enter-pop');
    const made = { li, img, remove };
    tiles.set(image, made);
    return made;
  };
  const drawAttachments = (): void => {
    attachments.hidden = !attached.length && !reading;
    for (const image of tiles.keys()) if (!attached.includes(image)) tiles.delete(image);
    const nodes = attached.map(tile);
    if (reading) nodes.push(readingTile);
    place(attachments, nodes);
    drawSend();
  };
  const attach = (files: readonly File[]): void => {
    const room = IMAGE_LIMITS.perMessage - attached.length - reading;
    if (files.length > room) notice(`At most ${IMAGE_LIMITS.perMessage} images per message.`, 'warn');
    for (const file of files.slice(0, Math.max(0, room))) {
      reading++;
      drawAttachments();
      toChatImage(file).then(
        image => { attached = [...attached, image]; },
        (error: unknown) => notice(`Image not attached: ${errorText(error)}`, 'error'),
      ).finally(() => { reading--; drawAttachments(); });
    }
  };
  attachButton.addEventListener('click', () => attachFile.click());
  attachFile.addEventListener('change', () => {
    attach([...attachFile.files ?? []]);
    attachFile.value = '';
  });
  // A pasted screenshot (or copied image file): attached, not pasted as text.
  input.addEventListener('paste', event => {
    const files = [...event.clipboardData?.files ?? []].filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  });
  composer.addEventListener('dragover', event => {
    if ([...event.dataTransfer?.items ?? []].some(item => item.kind === 'file')) event.preventDefault();
  });
  composer.addEventListener('drop', event => {
    const files = [...event.dataTransfer?.files ?? []].filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  });

  // -------------------------------------------------------------- composer

  /**
   * One button, as Pi Cloud's: send, steer while Pi works, and stop while Pi works and the box is empty. Stop never
   * shows while a send is unadmitted or just after one, and status.busy counts only while the link is ready (it is
   * stale otherwise); in those cases the button is a disabled send.
   */
  const drawSend = (): void => {
    if (!busy()) stopping = false;
    const typed = Boolean(input.value.trim()) || attached.length > 0;
    const working = linkReady && busy();
    const held = outbox.size > 0 || hush !== undefined;
    const mode = typed ? (working ? 'steer' : 'send') : working && !held ? 'stop' : 'send';
    sendButton.dataset.mode = mode;
    sendButton.disabled = mode === 'stop' ? stopping : !typed || reading > 0 || !loaded;
    const label = mode === 'stop' ? 'Stop Pi' : mode === 'steer' ? 'Steer Pi' : 'Send';
    sendButton.setAttribute('aria-label', label);
    sendButton.title = label;
    input.placeholder = busy() ? 'Steer Pi…' : 'Message Pi';
  };
  const autosize = (): void => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    drawSend();
  };
  const saveDraft = (): void => save(local, DRAFT_KEY, input.value);
  input.value = load(local, DRAFT_KEY);
  autosize();
  input.addEventListener('input', () => { autosize(); saveDraft(); });
  // Enter sends only with a keyboard and mouse; on a phone, Enter is a new line and the button sends.
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !finePointer.matches) return;
    event.preventDefault();
    // Enter only sends: stopping Pi takes the button (or Esc in the terminal), never a stray keypress.
    if ((input.value.trim() || attached.length) && !reading) submit();
  });
  composer.addEventListener('submit', event => {
    event.preventDefault();
    const stopTap = sendButton.dataset.mode === 'stop';
    submit();
    // A tap on stop must not raise the keyboard.
    if (!stopTap) input.focus();
  });

  // -------------------------------------------------------------- header

  byId('settings-button', HTMLButtonElement).addEventListener('click', () => sheet.open(chatSettingsView(ctx)));

  const drawStatus = (): void => {
    const status = store.status;
    if (!status) return;
    modelName.textContent = `${shortModel(status.model)} · ${status.thinkingLevel}`;
    drawSend();
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
    // Until the link is ready, items come from a snapshot (a first load, a reconnect): history, drawn without entrances.
    view.set(store.rootView(), linkReady);
    const status = JSON.stringify(store.status ?? null);
    if (status !== lastStatus) { lastStatus = status; drawStatus(); }
  });

  // -------------------------------------------------------------- link

  // A phone that wakes up reconnects in about a second: the banner waits RECONNECT_BANNER_MS, so that is not shown.
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  let bannerShown = false;
  const setBanner = (text: string, canRetry: boolean): void => {
    clearTimeout(bannerTimer);
    bannerShown = Boolean(text);
    banner.classList.toggle('is-shown', bannerShown);
    // Hiding keeps the last text and button, so the banner does not empty out while it slides away.
    if (!text) return;
    bannerText.textContent = text;
    retry.hidden = !canRetry;
  };
  retry.addEventListener('click', () => link.poke());

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
  const showSkeleton = (): void => show('chat', autosize);
  /** Applies the loading rule as it stands now: called at its marks and on each change of the link's state. */
  const loading = (): void => {
    const state = link.state;
    if (loaded || state === 'ready' || state === 'closed') return;
    const step = loadStep(performance.now() - loadStart, state);
    if (step.skeleton) showSkeleton();
    // One line at a time: a newer state's text replaces the one shown, never joins it.
    if (step.text && !(bannerShown && bannerText.textContent === step.text)) setBanner(step.text, step.retry);
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
      autosize();
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
    drawSend();
    if (state === 'ready') {
      wasReady = true;
      setBanner('', false);
      return;
    }
    if (wasReady && state !== 'closed') reopen = [...new Set([...reopen, ...store.disconnect()])];
    wasReady = false;
    if (state !== 'closed' && !loaded) loading();
    // A restart takes longer than a phone waking up: say so at once, so a dead-looking chat is explained.
    else if (state === 'reconnecting' && link.droppedWith === CloseCode.restart) setBanner(RESTARTING, true);
    else if (state === 'reconnecting') {
      const { text, retry: canRetry } = LINK_TEXT.reconnecting;
      if (!bannerShown) bannerTimer = setTimeout(() => setBanner(text, canRetry), RECONNECT_BANNER_MS);
      else setBanner(text, canRetry);
    }
    else if (state === 'offline') setBanner(LINK_TEXT.offline.text, LINK_TEXT.offline.retry);
    else if (state === 'closed') {
      const by = link.closedBy;
      if (by === 'unauthorized' || by === 'unpaired') {
        sheet.close();
        // A revoked device is told so, rather than finding the pairing screen with no reason.
        pairScreen(() => location.reload(), by === 'unauthorized' ? `${byeReason || 'This device is no longer paired.'} Pair it again with a new code.` : '');
      }
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
        for (const [id, { text, steer, images }] of outbox) deliver(id, text, steer, images);
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
    // Messages not yet admitted would be lost with the page: they go back into the draft.
    // Their images cannot be kept: only the text survives a reload.
    if (outbox.size) save(local, DRAFT_KEY, [...[...outbox.values()].map(sent => sent.text), input.value].filter(Boolean).join('\n\n'));
    await reloadOnce(value);
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
      setBanner(LINK_TEXT.offline.text, LINK_TEXT.offline.retry);
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
