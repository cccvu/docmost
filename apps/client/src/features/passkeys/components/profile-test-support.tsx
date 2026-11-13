import { PasskeyError, httpFailure } from "../lib/passkey-errors.ts";
import type { ConfirmItsYouDialogProps } from "./confirm-its-you-dialog.tsx";
import type { PasskeyListResponse, PasskeyView } from "../types.ts";

// #818 test support for the Profile → Passkeys specs (not a spec itself: no `.test.` in the name).

export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** A `t` that interpolates `{{x}}`, like the real one. */
export function translate(k: string, o?: Record<string, unknown>): string {
  return k.replace(/{{(\w+)}}/g, (_: string, n: string) => String(o?.[n]));
}

export function passkey(over: Partial<PasskeyView> = {}): PasskeyView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    credentialId: "Y3JlZC0x",
    aaguid: "00000000-0000-0000-0000-000000000000",
    backupEligible: true,
    backupState: true,
    transports: ["internal", "hybrid"],
    createdAt: "2026-11-02T12:00:00.000Z",
    lastUsedAt: null,
    removalPending: false,
    ...over,
  };
}

export function listResponse(
  passkeys: PasskeyView[],
  over: Partial<PasskeyListResponse> = {},
): PasskeyListResponse {
  return {
    passkeys,
    passkeysWorkUntil: "2027-02-10T12:00:00.000Z",
    max: 10,
    rpId: "wiki.example.test",
    userId: "AAECAwQFBgcICQoLDA0ODw",
    ...over,
  };
}

/** The platform's answer as the passkey api throws it (stage `request` = an axios call, `options` = the fetch). */
export function httpError(
  status: number,
  code?: string,
  opts: { stage?: "options" | "request"; retryAfter?: string } = {},
): PasskeyError {
  return new PasskeyError(
    httpFailure(
      opts.stage ?? "request",
      status,
      code ? { message: "x", code } : { message: "x" },
      opts.retryAfter ?? null,
    ),
  );
}

export function ceremonyError(name: string): PasskeyError {
  return new PasskeyError(
    name === "NotAllowedError" || name === "AbortError"
      ? { kind: "cancelled" }
      : name === "InvalidStateError"
        ? { kind: "already-registered" }
        : { kind: "ceremony", name },
  );
}

/**
 * A stand-in for ConfirmItsYouDialog (it has its own spec): shows which methods it was opened with and lets the
 * test confirm or dismiss it.
 */
export function StubConfirmDialog(props: ConfirmItsYouDialogProps) {
  if (!props.opened) return null;
  return (
    <div data-testid="confirm-dialog" data-methods={props.methods.join(",")}>
      <button type="button" onClick={() => void props.onConfirmed()}>
        stub-confirm
      </button>
      <button type="button" onClick={props.onClose}>
        stub-dismiss
      </button>
    </div>
  );
}
