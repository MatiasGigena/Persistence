// The one-line status under the chat: model, thinking, tools, work, memory and agents.
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { SessionStatus } from '../types.ts';
import type { Theme } from './theme.ts';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const size = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** What the footer reads of a SessionStatus: of the agents, only whether each is busy. */
export type FooterStatus = Omit<SessionStatus, 'agents'> & { readonly agents: readonly { readonly busy: boolean }[] };

/** The footer's text before truncation; `frame` picks the busy spinner's glyph. */
export function footerText(status: FooterStatus, theme: Theme, frame = 0): string {
  const { dim } = theme;
  const parts = [status.model, dim(`thinking ${status.thinkingLevel}`),
    status.toolsEnabled ? theme.warning('tools on') : dim('tools off')];
  if (status.busy) {
    parts.push(theme.accent(`${SPINNER[frame % SPINNER.length] ?? ''} working`));
    if (status.queued) parts.push(dim(`${status.queued} queued`));
  }
  const { memory } = status;
  if (memory) {
    parts.push(dim(`mem ${memory.messages} msgs`), dim(`${size(memory.viewBytes)} view`));
    if (memory.active) parts.push(dim(`${memory.active} summarizing`));
    if (memory.failed) parts.push(theme.error(`${memory.failed} failed`));
  }
  if (status.agents.length) {
    parts.push(dim(`${status.agents.filter(agent => agent.busy).length}/${status.agents.length} agents busy`));
  }
  return parts.join(dim(' · '));
}

/** Renders `footerText` for the current status, truncated to one line. `tick()` advances the spinner. */
export class Footer implements Component {
  private readonly status: () => FooterStatus;
  private readonly theme: Theme;
  private frame = 0;

  constructor(status: () => FooterStatus, theme: Theme) {
    this.status = status;
    this.theme = theme;
  }

  tick(): void { this.frame++; }
  invalidate(): void {}

  render(width: number): string[] {
    return [truncateToWidth(footerText(this.status(), this.theme, this.frame), width)];
  }
}
