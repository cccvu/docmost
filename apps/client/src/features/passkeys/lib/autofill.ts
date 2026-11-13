import { signInWithPasskey } from "../services/passkey-api.ts";
import type { PasskeySignInResponse } from "../types.ts";
import { autofillSupported } from "./capabilities.ts";
import { cancelPasskeyCeremony } from "./ceremony.ts";
import {
  PASSKEY_CODES,
  PasskeyError,
  failureCode,
  toPasskeyFailure,
  type PasskeyFailure,
} from "./passkey-errors.ts";

// wiki-v2 #818 — NOT upstream Docmost code. The login page's passkey autofill (a conditional request behind the
// `autoComplete="username webauthn"` email field). The only passkey prefetch: it fetches options on mount, not in a
// click, because the browser shows the prompt only when the person picks a passkey from the field's suggestions.
//
// Arm on step 1's mount; DISARM on a step change, on unmount, and BEFORE any button starts its own ceremony (the
// disarm cancels the open conditional request, so call it first, not after the button's `get()` began).
// Re-arms (a new fetch) only on `passkey_challenge_expired`; never after a 429 or any other answer.

export interface AutofillHandlers {
  onSignedIn: (response: PasskeySignInResponse) => void;
  /**
   * A failure the page should show (never a cancel or an expired challenge: those are handled here). Feed it to
   * `passkeyUiAction("autofill", …)`; the helper has already stopped, so arm again only from a new mount.
   */
  onFailure: (failure: PasskeyFailure) => void;
}

/** A bound on back-to-back re-arms, so a platform that keeps answering "expired" cannot spin the page. */
export const MAX_AUTOFILL_REARMS = 3;

/** Arms the conditional request; returns the disarm function. Does nothing when the browser has no autofill. */
export function armPasskeyAutofill(handlers: AutofillHandlers): () => void {
  let disarmed = false;
  let pending = false;

  const run = async () => {
    if (!(await autofillSupported())) return;
    let rearms = 0;
    while (!disarmed) {
      pending = true;
      try {
        const response = await signInWithPasskey({
          autofill: true,
          shouldContinue: () => !disarmed,
        });
        pending = false;
        if (!disarmed) handlers.onSignedIn(response);
        return;
      } catch (error) {
        pending = false;
        if (disarmed) return;
        const failure =
          error instanceof PasskeyError
            ? error.failure
            : toPasskeyFailure(error);
        if (failure.kind === "cancelled") return;
        if (failureCode(failure) === PASSKEY_CODES.challengeExpired) {
          // Past the bound the field simply stops offering passkeys; the buttons still work.
          if (rearms >= MAX_AUTOFILL_REARMS) return;
          rearms += 1;
          continue;
        }
        handlers.onFailure(failure);
        return;
      }
    }
  };
  void run();

  return () => {
    if (disarmed) return;
    disarmed = true;
    // Only our own request is cancelled: when nothing is pending there is nothing of ours open.
    if (pending) cancelPasskeyCeremony();
  };
}
