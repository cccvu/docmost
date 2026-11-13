import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";

// wiki-v2 #818 — NOT upstream Docmost code. What this browser can do with passkeys. Every probe answers `false`
// rather than throwing: a passkey control that cannot work is hidden, and the email path never depends on these.
// Whether the PLATFORM has passkeys is a different question, answered by the options routes (404/405 → hide, see
// `isPasskeysUnsupportedByServer`).

/** The browser has WebAuthn at all (a secure context with `PublicKeyCredential`). */
export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** The browser can offer passkeys in the email field's autofill (a conditional request). */
export async function autofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/** This device has a built-in authenticator (Touch ID, Windows Hello, an Android screen lock). For the nudge. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

type SignalName = "signalUnknownCredential" | "signalAllAcceptedCredentials";

/** The Signal API is Chrome and Safari only: feature-detect each method before calling it. */
export function canSignal(name: SignalName): boolean {
  const pkc = (globalThis as { PublicKeyCredential?: unknown })
    .PublicKeyCredential as Record<string, unknown> | undefined;
  return typeof pkc?.[name] === "function";
}
