/** Access may itself throw when browser storage is disabled. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Best-effort preferences only; edit logs must handle read failures explicitly. */
export function readPreference(key: string): string | null {
  try { return browserStorage()?.getItem(key) ?? null; } catch { return null; }
}

export function writePreference(key: string, value: string): void {
  try { browserStorage()?.setItem(key, value); } catch { /* Preferences are optional. */ }
}
