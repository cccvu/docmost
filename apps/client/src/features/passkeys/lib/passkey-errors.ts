import { isAxiosError } from "axios";
import type { Translate } from "@/features/request-errors/request-error.ts";
import type { ConfirmMethod, PasskeyErrorBody } from "../types.ts";

// wiki-v2 #818 — NOT upstream Docmost code. Every passkey failure, whatever produced it (the native options fetch,
// the browser ceremony, or an axios call to the platform), becomes ONE `PasskeyFailure`, and ONE table
// (`passkeyUiAction`) turns it into what the UI does (#818 contract §7). Clients read the body's `code` when there is
// one and otherwise branch on the status alone; a server `message` is never parsed or shown.

/** Where in a passkey call the failure happened. `options` = the native fetch before the ceremony. */
export type PasskeyStage = "options" | "ceremony" | "request";

export type PasskeyFailure =
  | {
      kind: "http";
      stage: PasskeyStage;
      status: number;
      code: string | null;
      /** Only on sign-in's `403 email_confirmation_required`: the address the code step needs. */
      email: string | null;
      retryAfterSeconds: number | null;
    }
  /** The person dismissed the browser prompt, it timed out, or another ceremony replaced it. Never a banner. */
  | { kind: "cancelled" }
  /** `InvalidStateError` from `create()`: this authenticator already holds a passkey for the account. */
  | { kind: "already-registered" }
  /** Any other browser refusal (no WebAuthn, a security error, an unsupported algorithm…). */
  | { kind: "ceremony"; name: string }
  /** `POST /auth/reauth/passkey/options` answered `{available:false}`: use the email code instead. */
  | { kind: "unavailable" }
  /** No response at all: offline, DNS, a dropped connection. */
  | { kind: "network"; stage: PasskeyStage }
  | { kind: "unknown" };

/** The one error type the passkey api throws. */
export class PasskeyError extends Error {
  readonly failure: PasskeyFailure;
  constructor(failure: PasskeyFailure, options?: { cause?: unknown }) {
    super(`passkey ${failure.kind}`);
    this.name = "PasskeyError";
    this.failure = failure;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// The codes this feature branches on (#818 contract §2). Anything else is treated by status alone.
export const PASSKEY_CODES = {
  notRecognized: "passkey_not_recognized",
  challengeExpired: "passkey_challenge_expired",
  failed: "passkey_failed",
  emailConfirmationRequired: "email_confirmation_required",
  challengeStale: "passkey_challenge_stale",
  rejected: "passkey_rejected",
  limitReached: "passkey_limit_reached",
  alreadyRegistered: "passkey_already_registered",
  signOutIncomplete: "sign_out_incomplete",
  stepUpRequired: "step_up_required",
  rateLimited: "rate_limited",
} as const;

function bodyField(body: unknown, key: keyof PasskeyErrorBody): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

/** Only positive delta-seconds count: every emitter in front of the platform sends seconds. */
export function parseRetryAfter(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim())) return null;
  const seconds = Number(text.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** An http failure from a status, a (possibly absent or non-JSON) body and a Retry-After header value. */
export function httpFailure(
  stage: PasskeyStage,
  status: number,
  body: unknown,
  retryAfter: unknown,
): PasskeyFailure {
  return {
    kind: "http",
    stage,
    status,
    code: bodyField(body, "code"),
    email: bodyField(body, "email"),
    retryAfterSeconds: parseRetryAfter(retryAfter),
  };
}

/** A non-2xx answer to the native options fetch. The body is read defensively: a proxy may answer HTML. */
export async function failureFromResponse(
  res: Response,
  stage: PasskeyStage = "options",
): Promise<PasskeyFailure> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return httpFailure(
    stage,
    res.status,
    body,
    res.headers?.get?.("retry-after"),
  );
}

/** A failure of an axios call to the platform. */
export function failureFromAxios(
  error: unknown,
  stage: PasskeyStage = "request",
): PasskeyFailure {
  if (!isAxiosError(error)) return { kind: "unknown" };
  if (!error.response) {
    return error.code === "ERR_CANCELED"
      ? { kind: "cancelled" }
      : { kind: "network", stage };
  }
  const headers = error.response.headers as
    | { get?: (name: string) => unknown; [name: string]: unknown }
    | undefined;
  const retryAfter =
    typeof headers?.get === "function"
      ? headers.get("retry-after")
      : headers?.["retry-after"];
  return httpFailure(
    stage,
    error.response.status,
    error.response.data,
    retryAfter,
  );
}

/** A rejection of `startAuthentication` / `startRegistration` (a `WebAuthnError`, a `DOMException` or a plain Error). */
export function failureFromCeremony(error: unknown): PasskeyFailure {
  const name =
    error !== null && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "Error";
  if (name === "NotAllowedError" || name === "AbortError") {
    return { kind: "cancelled" };
  }
  if (name === "InvalidStateError") return { kind: "already-registered" };
  return { kind: "ceremony", name };
}

/** Any thrown value as a `PasskeyFailure`. */
export function toPasskeyFailure(error: unknown): PasskeyFailure {
  if (error instanceof PasskeyError) return error.failure;
  if (isAxiosError(error)) return failureFromAxios(error);
  return { kind: "unknown" };
}

function isHttp(
  failure: PasskeyFailure,
): failure is Extract<PasskeyFailure, { kind: "http" }> {
  return failure.kind === "http";
}

export function failureCode(failure: PasskeyFailure): string | null {
  return isHttp(failure) ? failure.code : null;
}

/** An options route the platform does not have (an older platform task): every passkey control hides. */
export function isPasskeysUnsupportedByServer(
  failure: PasskeyFailure,
): boolean {
  return (
    isHttp(failure) &&
    failure.stage === "options" &&
    (failure.status === 404 || failure.status === 405)
  );
}

/**
 * The ONE place that decides the browser may drop a credential: only a sign-in verify answered
 * `401 passkey_not_recognized` (the credential has no live row, or its row can never work again). Every other
 * answer, and every answer from a signed-in route, leaves the credential alone.
 */
export function shouldSignalUnknownCredential(
  failure: PasskeyFailure,
): boolean {
  return (
    isHttp(failure) &&
    failure.stage === "request" &&
    failure.status === 401 &&
    failure.code === PASSKEY_CODES.notRecognized
  );
}

/** Which passkey action failed; the same answer can mean different things on different surfaces. */
export type PasskeyOperation =
  | "signin" // the login page button (step 1 or the code step)
  | "autofill" // the login page's conditional (autofill) request
  | "reauth" // the passkey method inside ConfirmItsYouDialog
  | "add" // Profile → Add a passkey
  | "remove" // Profile → Remove passkey
  | "list"; // Profile → the passkey list

export type PasskeyUiAction =
  /** No banner; leave the controls enabled (the person cancelled, or the ceremony was replaced). */
  | { kind: "none" }
  /** An older platform without passkeys: hide every passkey control; the email path is unchanged. */
  | { kind: "hide" }
  /** Autofill only: fetch new options and arm the conditional request again. */
  | { kind: "rearm" }
  /** Sign-in: switch to the email code step, prefilled with `email` when the platform sent it, and request a code. */
  | { kind: "code-step"; email: string | null }
  /** Open ConfirmItsYouDialog with these methods; a NEW click retries afterwards (Safari's gesture rule). */
  | { kind: "confirm"; methods: ConfirmMethod[] }
  /** Inside ConfirmItsYouDialog: the passkey method cannot be used, switch to the emailed code. */
  | { kind: "use-email"; message: string | null }
  /** DELETE answered 404: the row is gone (or never was); refresh the list. */
  | { kind: "refresh-list" }
  /** Removal stopped the passkey but the other-device sign-out did not finish: show the row's "Try again". */
  | {
      kind: "removal-incomplete";
      message: string;
      retryAfterSeconds: number | null;
    }
  | {
      kind: "message";
      message: string;
      /** Offer "Email me a code instead". */
      offerEmail: boolean;
      /** Offer "Try again" (a new click). */
      retry: boolean;
    };

function message(
  text: string,
  opts: { offerEmail?: boolean; retry?: boolean } = {},
): PasskeyUiAction {
  return {
    kind: "message",
    message: text,
    offerEmail: opts.offerEmail ?? false,
    retry: opts.retry ?? false,
  };
}

function isLogin(op: PasskeyOperation): boolean {
  return op === "signin" || op === "autofill";
}

/**
 * The #818 contract §7 table: what the UI does for a failure of `op`. Strings are `t("…")` literals so the
 * translation harvest finds them.
 */
export function passkeyUiAction(
  op: PasskeyOperation,
  failure: PasskeyFailure,
  t: Translate,
): PasskeyUiAction {
  switch (failure.kind) {
    case "cancelled":
      return { kind: "none" };
    case "unavailable":
      return op === "reauth"
        ? { kind: "use-email", message: null }
        : { kind: "hide" };
    case "already-registered":
      return message(t("This device already has a passkey for your account."));
    case "network":
      return message(
        t("Couldn't reach the server. Check your connection and try again."),
        { offerEmail: isLogin(op), retry: true },
      );
    case "ceremony":
      return isLogin(op)
        ? message(t("This browser couldn't use a passkey here."), {
            offerEmail: true,
          })
        : op === "reauth"
          ? {
              kind: "use-email",
              message: t("This browser couldn't use a passkey here."),
            }
          : message(t("This browser couldn't use a passkey here."));
    case "unknown":
      return isLogin(op)
        ? message(t("We couldn't sign you in with that passkey."), {
            offerEmail: true,
            retry: true,
          })
        : message(t("Something went wrong. Try again."), { retry: true });
    case "http":
      return httpAction(op, failure, t);
  }
}

function httpAction(
  op: PasskeyOperation,
  f: Extract<PasskeyFailure, { kind: "http" }>,
  t: Translate,
): PasskeyUiAction {
  const login = isLogin(op);

  // An older platform: the options route does not exist. A dialog's passkey method falls back to email.
  if (
    isPasskeysUnsupportedByServer(f) ||
    (op === "list" && (f.status === 404 || f.status === 405))
  ) {
    return op === "reauth"
      ? { kind: "use-email", message: null }
      : { kind: "hide" };
  }

  if (f.status === 429) {
    return login
      ? message(t("Too many attempts. Wait a moment, or email me a code."), {
          offerEmail: true,
        })
      : message(t("Too many attempts, try again in a moment."));
  }

  switch (f.code) {
    case PASSKEY_CODES.notRecognized:
      // The browser is told to drop the credential by the api (shouldSignalUnknownCredential), not here.
      return message(t("That passkey isn't set up for this account anymore."), {
        offerEmail: true,
      });
    case PASSKEY_CODES.challengeExpired:
      return op === "autofill"
        ? { kind: "rearm" }
        : message(t("That took too long. Choose your passkey again."), {
            retry: true,
          });
    case PASSKEY_CODES.failed:
      return message(t("We couldn't sign you in with that passkey."), {
        offerEmail: true,
        retry: true,
      });
    case PASSKEY_CODES.emailConfirmationRequired:
      if (login) return { kind: "code-step", email: f.email };
      if (op === "reauth") {
        return {
          kind: "use-email",
          message: t("Confirm with a code from your email this time."),
        };
      }
      return { kind: "confirm", methods: ["email"] };
    case PASSKEY_CODES.stepUpRequired:
      if (op === "add") return { kind: "confirm", methods: ["email"] };
      if (op === "remove")
        return { kind: "confirm", methods: ["passkey", "email"] };
      break;
    case PASSKEY_CODES.challengeStale:
      return message(t("That took too long. Try again."), { retry: true });
    case PASSKEY_CODES.rejected:
      return op === "reauth"
        ? {
            kind: "use-email",
            message: t("That passkey didn't work for your account."),
          }
        : message(t("That passkey didn't work for your account."), {
            offerEmail: true,
          });
    case PASSKEY_CODES.limitReached:
      return message(t("You already have 10 passkeys. Remove one first."));
    case PASSKEY_CODES.alreadyRegistered:
      return message(t("This device already has a passkey for your account."));
    case PASSKEY_CODES.signOutIncomplete:
      return {
        kind: "removal-incomplete",
        message: t("Removal not finished. Try again."),
        retryAfterSeconds: f.retryAfterSeconds,
      };
  }

  if (op === "remove" && f.status === 404) return { kind: "refresh-list" };
  if (f.status === 503) {
    return login
      ? message(
          t(
            "Sign-in is temporarily unavailable. Try again, or email me a code.",
          ),
          { offerEmail: true, retry: true },
        )
      : message(t("Temporarily unavailable, try again."), { retry: true });
  }
  if (f.status === 401 && !login) {
    return message(t("Your session has ended. Sign in again."));
  }
  return login
    ? message(t("We couldn't sign you in with that passkey."), {
        offerEmail: true,
        retry: true,
      })
    : message(t("Something went wrong. Try again."), { retry: true });
}
