// Reasoning efforts, the one list the CLI, settings, `/effort` and the model chooser check against.
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

/** Every reasoning effort (thinking level), lowest first. */
export const THINKING: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const isThinkingLevel = (x: unknown): x is ModelThinkingLevel => THINKING.some(level => level === x);
