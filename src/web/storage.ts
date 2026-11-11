// The page's own conveniences in web storage (a draft, a reload marker): every read and write tolerates storage that
// is missing, full or refused (private mode), since nothing here must persist.

export const local = (): Storage => localStorage;
export const session = (): Storage => sessionStorage;

/** `key`'s value, or '' when there is none or storage is unavailable. */
export function load(storage: () => Storage, key: string): string {
  try { return storage().getItem(key) ?? ''; } catch { return ''; }
}

/** Stores `value` under `key`; '' removes it. */
export function save(storage: () => Storage, key: string, value: string): void {
  try {
    if (value) storage().setItem(key, value);
    else storage().removeItem(key);
  } catch { /* private mode or full: a convenience only */ }
}
