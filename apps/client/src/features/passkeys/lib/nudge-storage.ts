// wiki-v2 #818 — NOT upstream Docmost code. "Don't ask again on this device" for the post-sign-in passkey nudge.
//
// One flag per BROWSER, not per person: the choice is about this device ("only create a passkey on a device that's
// yours"), and keying it by account would put an identifier in storage for no gain. Every storage access is in
// try/catch: a private window, blocked site data or a full quota must never break a sign-in. Unreadable storage
// reads as "not dismissed" (the nudge is skippable), and a failed write is silently lost.

export const PASSKEY_NUDGE_STORAGE_KEY = "wiki.passkeyNudge.dismissed";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether this browser was told "Don't ask again on this device". */
export function isPasskeyNudgeDismissed(): boolean {
  try {
    return storage()?.getItem(PASSKEY_NUDGE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember "Don't ask again on this device". Best effort. */
export function dismissPasskeyNudge(): void {
  try {
    storage()?.setItem(PASSKEY_NUDGE_STORAGE_KEY, "1");
  } catch {
    // Storage blocked or full: the nudge may show again next time, which is harmless.
  }
}
