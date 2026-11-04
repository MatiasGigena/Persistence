// Stray console output while a chat owns the screen (the TUI) or has clients (the server): console.error and
// console.warn become chat notices, so runtime reports and memory warnings are seen rather than lost or drawn over.
import { format } from 'node:util';

/**
 * Sends what console.error and console.warn print to `notify`, formatted as the console would; `echo` also prints it
 * as before (the server's journal). Returns the function that puts the console back.
 */
export function redirectConsole(notify: (text: string) => void, { echo = false }: { readonly echo?: boolean } = {}): () => void {
  const { error, warn } = console;
  const to = (original: (...args: unknown[]) => void) => (...args: unknown[]): void => {
    if (echo) original(...args);
    notify(format(...args));
  };
  console.error = to(error);
  console.warn = to(warn);
  return () => {
    console.error = error;
    console.warn = warn;
  };
}
