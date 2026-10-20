// The one-line status under the chat: model, thinking, tools, work, memory and agents. Segments that do not fit
// are dropped by priority, so the tools state and the busy spinner survive on a phone-width terminal.
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { SessionStatus } from '../types.ts';
import { NARROW } from './theme.ts';
import type { Theme } from './theme.ts';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** Spinner frame interval on a local, wide terminal. */
export const SPIN_FAST = 80;
/** Over SSH or on a narrow screen, where every frame is network traffic. */
export const SPIN_SLOW = 250;

/** The spinner's interval: slow when `SSH_CONNECTION` is set or the terminal is narrower than NARROW. */
export function spinnerInterval(env: Readonly<Record<string, string | undefined>>, width: number): number {
  return env['SSH_CONNECTION'] || width < NARROW ? SPIN_SLOW : SPIN_FAST;
}

const size = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * What the footer reads of a SessionStatus: of the agents, only whether each is busy. `reconnecting` is set by an
 * attached TUI while its link to the server is down; the status shown is then the last one received.
 */
export type FooterStatus = Omit<SessionStatus, 'agents'> & {
  readonly agents: readonly { readonly busy: boolean }[];
  readonly reconnecting?: boolean;
  /** The tool call running now, as "name summary" on one line; shown next to the spinner while busy. */
  readonly step?: string;
};

/** Longest step shown, in columns: wide and compact. */
export const STEP_WIDTH = 60;
export const STEP_COMPACT = 24;

/** One footer segment: `rank` orders what is kept when the line is too narrow (0 first). */
interface Segment { readonly text: string; readonly rank: number }

/** Tools state and a lost link: shown at every width. */
const TOOLS = -1;

/** The segments in display order; `compact` asks for the short forms used below NARROW columns. */
function segments(status: FooterStatus, theme: Theme, frame: number, compact: boolean): Segment[] {
  const { dim } = theme;
  const slash = status.model.indexOf('/');
  const model = compact && slash > 0 ? status.model.slice(slash + 1) : status.model;
  const list: Segment[] = [
    ...status.reconnecting ? [{ text: theme.warning('reconnecting…'), rank: TOOLS }] : [],
    { text: model, rank: 4 },
    { text: dim(compact ? `think ${status.thinkingLevel}` : `thinking ${status.thinkingLevel}`), rank: 7 },
    { text: status.toolsEnabled ? theme.warning('tools on') : dim('tools off'), rank: TOOLS },
  ];
  if (status.busy) {
    list.push({ text: theme.accent(`${SPINNER[frame % SPINNER.length] ?? ''} ${compact ? 'busy' : 'working'}`), rank: 0 });
    if (status.step) list.push({ text: dim(truncateToWidth(status.step, compact ? STEP_COMPACT : STEP_WIDTH, '…')), rank: 1 });
    if (status.queued) list.push({ text: dim(`${status.queued} queued`), rank: 2 });
  }
  const { memory } = status;
  if (memory) {
    if (compact) list.push({ text: dim(`mem ${size(memory.viewBytes).replace(' ', '')}`), rank: 6 });
    else list.push({ text: dim(`mem ${memory.messages} msgs`), rank: 6 }, { text: dim(`${size(memory.viewBytes)} view`), rank: 6 });
    if (memory.active) list.push({ text: dim(compact ? `${memory.active} sum` : `${memory.active} summarizing`), rank: 8 });
    if (memory.failed) list.push({ text: theme.error(`${memory.failed} failed`), rank: 5 });
  }
  if (status.agents.length) {
    const busy = status.agents.filter(agent => agent.busy).length;
    list.push({ text: dim(compact ? `${busy}/${status.agents.length} ag` : `${busy}/${status.agents.length} agents busy`), rank: 3 });
  }
  return list;
}

/**
 * The footer's text within `width` columns (default: unlimited); `frame` picks the busy spinner's glyph.
 * Below NARROW columns it uses short forms. Segments are kept in priority order (working, tools, current step,
 * queued, agents, model, memory failures, memory size, thinking, summaries) until one does not fit, and shown in their
 * usual order; the tools state and "reconnecting…" are never dropped.
 */
export function footerText(status: FooterStatus, theme: Theme, frame = 0, width = Number.POSITIVE_INFINITY): string {
  const separator = theme.dim(' · ');
  const all = segments(status, theme, frame, width < NARROW);
  const kept = new Set<Segment>(all.filter(s => s.rank === TOOLS));
  let used = [...kept].reduce((sum, s) => sum + visibleWidth(s.text), 0);
  for (const segment of [...all].sort((a, b) => a.rank - b.rank)) {
    if (kept.has(segment)) continue;
    const extra = visibleWidth(segment.text) + visibleWidth(separator);
    if (used + extra > width) break;
    kept.add(segment);
    used += extra;
  }
  return all.filter(s => kept.has(s)).map(s => s.text).join(separator);
}

/** Renders `footerText` for the current status at the render width. `tick()` advances the spinner. */
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
    return [truncateToWidth(footerText(this.status(), this.theme, this.frame, width), width, '…')];
  }
}
