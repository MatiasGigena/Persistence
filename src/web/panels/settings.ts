// Settings: notifications for this device, its name, and the full status (the terminal's /status).
import { el } from '../chat-view.ts';
import { errorText, statusText } from '../format.ts';
import { disablePush, enablePush, pushState } from '../push.ts';
import type { PushState } from '../push.ts';
import type { PanelContext, View } from './sheet.ts';

const PUSH_TEXT: Readonly<Record<PushState, string>> = {
  unsupported: 'This browser cannot show notifications from the server.',
  install: 'On iPhone and iPad, notifications need the app on the Home Screen. Tap Share, then Add to Home Screen, and open Persistence from there.',
  'no-key': 'The server has notifications off. They need PI_DURABLE_ORIGIN to be set.',
  denied: 'Notifications are blocked for this site. Allow them in the browser settings, then come back.',
  off: 'Get a notification when Pi answers or an agent reports while this app is closed.',
  on: 'You get a notification when Pi answers or an agent reports while no app is open.',
};

export function settingsView(ctx: PanelContext): View {
  let unsubscribe = (): void => undefined;
  return {
    title: 'Settings',
    render(body) {
      const pushSection = el('section', 'settings-section');
      const pushTitle = el('h3', 'settings-title', 'Notifications');
      const pushNote = el('p', 'sheet-note');
      const pushButton = el('button', 'btn');
      pushButton.type = 'button';
      pushSection.append(pushTitle, pushNote, pushButton);

      const device = el('section', 'settings-section');
      const welcome = ctx.store.welcome;
      device.append(el('h3', 'settings-title', 'This device'),
        el('p', 'sheet-note', welcome?.device ? `Paired as “${welcome.device}”.` : 'Not paired.'),
        el('p', 'sheet-note', 'To unpair it, run pi-durable serve devices --revoke NAME on the server.'));

      const status = el('section', 'settings-section');
      const statusBody = el('pre', 'status-text');
      status.append(el('h3', 'settings-title', 'Status'), statusBody,
        el('p', 'sheet-note', welcome ? `Server ${welcome.server}, working in ${welcome.cwd}.` : ''));
      body.append(pushSection, device, status);

      let state: PushState = 'unsupported';
      const drawPush = (): void => {
        pushNote.textContent = PUSH_TEXT[state];
        pushButton.hidden = state !== 'on' && state !== 'off';
        pushButton.textContent = state === 'on' ? 'Turn off notifications' : 'Turn on notifications';
      };
      const refresh = (): void => {
        void pushState(ctx.store.welcome?.pushKey).then(next => { state = next; drawPush(); });
      };
      pushButton.addEventListener('click', () => {
        const key = ctx.store.welcome?.pushKey;
        if (!key) return;
        pushButton.disabled = true;
        // enablePush asks for permission first thing: the prompt must come straight from this tap.
        (state === 'on' ? disablePush(ctx.link) : enablePush(ctx.link, key)).then(
          () => ctx.notice(state === 'on' ? 'Notifications off for this device.' : 'Notifications on for this device.'),
          (error: unknown) => { pushNote.textContent = errorText(error); },
        ).finally(() => { pushButton.disabled = false; refresh(); });
      });
      refresh();

      const drawStatus = (): void => { statusBody.textContent = ctx.store.status ? statusText(ctx.store.status) : 'No status yet.'; };
      unsubscribe = ctx.store.subscribe(drawStatus);
      drawStatus();
    },
    dispose() { unsubscribe(); },
  };
}
