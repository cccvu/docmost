// wiki-v2 #939 — NOT upstream Docmost code. "Dismiss" for the site announcement banner, remembered per browser.
//
// The stored value is the dismissed announcement's VERSION, so any edit (a new version) shows the banner again.
// Every storage access is in try/catch (the nudge-storage.ts pattern): a private window, blocked site data or a
// full quota must never break a page. Unreadable storage reads as "not dismissed", and a failed write is lost: the
// banner shows again on the next load, which is harmless.

export const ANNOUNCEMENT_DISMISSED_KEY = "wiki.announcement.dismissed";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The version this browser dismissed, or null. */
export function readDismissedVersion(): number | null {
  try {
    const raw = storage()?.getItem(ANNOUNCEMENT_DISMISSED_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Number.isInteger((parsed as { version?: unknown }).version)
    ) {
      return (parsed as { version: number }).version;
    }
    return null;
  } catch {
    return null;
  }
}

/** Remember that this browser dismissed `version`. Best effort. */
export function storeDismissedVersion(version: number): void {
  try {
    storage()?.setItem(ANNOUNCEMENT_DISMISSED_KEY, JSON.stringify({ version }));
  } catch {
    // Storage blocked or full: the banner shows again next time.
  }
}
