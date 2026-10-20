// Coding tools: on or off for this server run (the chat settings' switch). Turning them on asks first, in a dialog
// that states what they can do, and sends `confirm: 'enable-tools'` only after a yes. The server turns them off after
// its idle minutes.
import { errorText } from '../format.ts';
import { ENABLE_TOOLS } from '../../protocol/messages.ts';
import { byId } from './sheet.ts';
import type { PanelContext } from './sheet.ts';

/** The confirmation's text: what the tools can do, where, and when they turn off. */
export function toolsQuestion(cwd: string, idleMinutes: number | undefined): string {
  return `Pi and its agents get read, write, edit and bash with your user's permissions on the server, working in ${cwd}.`
    + ' The chat\'s own files and your credentials stay hidden from them, and system folders read-only; there are no approval prompts.'
    + (idleMinutes === undefined ? '' : ` They turn off after ${idleMinutes} minutes without work.`);
}

/** Asks the user in the tools dialog; resolves true for "Turn on tools". */
export function confirmTools(ctx: PanelContext): Promise<boolean> {
  const dialog = byId('tools-confirm', HTMLDialogElement);
  const welcome = ctx.store.welcome;
  byId('tools-confirm-text', HTMLParagraphElement).textContent = toolsQuestion(welcome?.cwd ?? 'the server', welcome?.tools.idleMinutes);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'enable'), { once: true }));
}

/** Turns the tools on (after asking) or off, and says so in the chat. */
export async function setTools(ctx: PanelContext, enabled: boolean): Promise<boolean> {
  if (enabled && !await confirmTools(ctx)) {
    ctx.notice('Coding tools stay off.');
    return false;
  }
  try {
    await ctx.link.request('tools.set', enabled ? { enabled, confirm: ENABLE_TOOLS } : { enabled });
    return true;
  } catch (error) {
    ctx.notice(`Tools not changed: ${errorText(error)}`, 'error');
    return false;
  }
}
