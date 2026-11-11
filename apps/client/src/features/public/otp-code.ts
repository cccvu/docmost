import {
  isRateLimited,
  retryAfterMs,
} from "@/features/request-errors/request-error.ts";

// wiki-v2 #815 — NOT upstream Docmost code. The one rule for the emailed sign-in code on this client. The platform
// is moving the code from 6 to 8 digits (one release AFTER this one), so the field takes any code from 6 to 12
// digits: both lengths work across the rollout and a rollback, and no length is hard-coded in the UI. The console
// (services/admin-ui) keeps its own copy of this rule; the fork cannot import super-repo code.

export const OTP_MIN_DIGITS = 6;
export const OTP_MAX_DIGITS = 12;
// Room for 12 digits with a separator between every pair, so a pasted "1234 5678" or "1234-5678" always fits and a
// pasted paragraph does not.
export const OTP_INPUT_MAX_LENGTH = 24;
// The wait before "Resend email" works again after a code was sent.
export const RESEND_COOLDOWN_SECONDS = 60;

/** The code as typed or pasted, with spaces and hyphens removed (the email groups it as "1234 5678"). */
export function normalizeOtp(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** True when the input is a code the platform can check: 6 to 12 digits once separators are removed. */
export function isCompleteOtp(raw: string): boolean {
  return new RegExp(`^\\d{${OTP_MIN_DIGITS},${OTP_MAX_DIGITS}}$`).test(
    normalizeOtp(raw),
  );
}

/** Submit is offered from the sixth digit on; a malformed value is explained on submit, never silently ignored. */
export function hasMinimumDigits(raw: string): boolean {
  return (raw.match(/\d/g)?.length ?? 0) >= OTP_MIN_DIGITS;
}

// InputEvent types that put a whole value in at once: a paste, a drop, or an autofill/replacement (iOS and Android
// fill a one-time code as a replacement).
const BULK_INPUT_TYPES = new Set([
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
  "insertReplacementText",
  "insertFromYank",
]);

/**
 * True when one change inserted the value in bulk (a paste or an autofill), never for typing. Typing inserts one
 * character per event; an autofill that reports no input type at all still inserts more than one, so the length
 * jump covers it. Only a bulk entry may auto-submit: a typed code is submitted by the person.
 */
export function isBulkEntry(
  previous: string,
  next: string,
  inputType?: string | null,
): boolean {
  if (inputType && BULK_INPUT_TYPES.has(inputType)) return true;
  return next.length - previous.length > 1;
}

// The narrow slice of i18next's `t` used here.
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The 429 text. Honest about the wait: it names the server's Retry-After when the response carries one. */
export function tooManyRequestsMessage(error: unknown, t: Translate): string {
  const ms = retryAfterMs(error);
  if (ms === null)
    return t("Too many requests. Wait a few minutes, then try again.");
  const seconds = Math.max(2, Math.ceil(ms / 1000));
  if (seconds <= 90) {
    return t("Too many requests. Wait {{seconds}} seconds, then try again.", {
      seconds,
    });
  }
  return t("Too many requests. Wait {{minutes}} minutes, then try again.", {
    minutes: Math.ceil(seconds / 60),
  });
}

export { isRateLimited };
