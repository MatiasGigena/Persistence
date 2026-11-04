// Coding tools: on or off for this server run (the chat settings' switch). Turning them on asks first, in a dialog
// that states what they can do, and sends `confirm: 'enable-tools'` only after a yes. The server turns them off after
// its idle minutes.
import { errorMessage } from '../../protocol/util.ts';
import { ENABLE_TOOLS } from '../../protocol/messages.ts';
import { byId, closeDialog, showDialog } from './sheet.ts';
import type { PanelContext } from './sheet.ts';

/** The confirmation's text: what the tools can do, where, and when they turn off. */
export function toolsQuestion(cwd: string, idleMinutes: number | undefined): string {
  return `Pi and its agents get read, write, edit and bash with your user's permissions on the server, working in ${cwd}.`
    + ' The chat\'s own files and your credentials stay hidden from them, and system folders read-only; there are no approval prompts.'
    + (idleMinutes === undefined ? '' : ` They turn off after ${idleMinutes} minutes without work.`);
}

/**
 * Asks the user in the tools dialog; resolves true for "Turn on tools". The dialog pops in, and leaves (a button,
 * Escape or the back gesture) by fading out before it closes, so its answer and its `close` come after the exit.
 */
export function confirmTools(ctx: PanelContext): Promise<boolean> {
  const dialog = byId('tools-confirm', HTMLDialogElement);
  const form = dialog.querySelector('form');
  const welcome = ctx.store.welcome;
  byId('tools-confirm-text', HTMLParagraphElement).textContent = toolsQuestion(welcome?.cwd ?? 'the server', welcome?.tools.idleMinutes);
  dialog.returnValue = '';
  let leaving: (() => void) | undefined;
  const leave = (value: string): void => { leaving ??= closeDialog(dialog, value); };
  // The buttons submit the `method="dialog"` form, which would close at once: close with the exit instead.
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    leave(event.submitter instanceof HTMLButtonElement ? event.submitter.value : '');
  };
  // Should the browser not let Escape be held, the dialog closes at once, unanswered, as before.
  const onCancel = (event: Event): void => {
    event.preventDefault();
    leave('');
  };
  form?.addEventListener('submit', onSubmit);
  dialog.addEventListener('cancel', onCancel);
  showDialog(dialog);
  return new Promise(resolve => dialog.addEventListener('close', () => {
    // Closed by the browser mid-exit: the pending close must not hit the dialog shown again.
    leaving?.();
    form?.removeEventListener('submit', onSubmit);
    dialog.removeEventListener('cancel', onCancel);
    resolve(dialog.returnValue === 'enable');
  }, { once: true }));
}

/**
 * Turns the tools on (after asking) or off, and says so in the chat. Resolves to why the change failed, for the sheet
 * to show where the switch is; '' when it went through or the user declined.
 */
export async function setTools(ctx: PanelContext, enabled: boolean): Promise<string> {
  if (enabled && !await confirmTools(ctx)) {
    ctx.notice('Coding tools stay off.');
    return '';
  }
  try {
    await ctx.link.request('tools.set', enabled ? { enabled, confirm: ENABLE_TOOLS } : { enabled });
    return '';
  } catch (error) {
    const why = `Tools not changed: ${errorMessage(error)}`;
    ctx.notice(why, 'error');
    return why;
  }
}
