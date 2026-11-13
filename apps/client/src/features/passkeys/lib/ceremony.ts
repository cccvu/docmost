import {
  WebAuthnAbortService,
  sendSignal,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { canSignal } from "./capabilities.ts";
import { PasskeyError, failureFromCeremony } from "./passkey-errors.ts";

// wiki-v2 #818 — NOT upstream Docmost code. The browser half of a passkey ceremony, statically imported (a dynamic
// import is an extra await between the click and `get()`/`create()`, which Safari counts against the user gesture).
// Every rejection becomes a `PasskeyError` with stage `ceremony`.

/** `navigator.credentials.get()`; with `autofill`, the conditional request behind the email field. */
export async function runAuthentication(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
  opts: { autofill?: boolean } = {},
): Promise<AuthenticationResponseJSON> {
  try {
    return await startAuthentication({
      optionsJSON,
      useBrowserAutofill: opts.autofill === true,
    });
  } catch (error) {
    throw new PasskeyError(failureFromCeremony(error), { cause: error });
  }
}

/** `navigator.credentials.create()`. */
export async function runRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  try {
    return await startRegistration({ optionsJSON });
  } catch (error) {
    throw new PasskeyError(failureFromCeremony(error), { cause: error });
  }
}

/** Abort whatever ceremony is open (a step change, a button click, an unmount). Rejects it as an AbortError. */
export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

/**
 * Tell the browser this credential will never work here again, so it can stop offering it. Called ONLY by the
 * sign-in api, ONLY for `401 passkey_not_recognized` (`shouldSignalUnknownCredential`). Best effort: never awaited
 * by the UI, never throws.
 */
export function signalUnknownCredential(
  rpId: string | undefined,
  credentialId: string,
): void {
  if (!rpId || !credentialId || !canSignal("signalUnknownCredential")) return;
  void sendSignal({
    signalName: "unknownCredential",
    rpID: rpId,
    credentialID: credentialId,
  }).catch(() => undefined);
}

/**
 * Tell the browser which of this user's credentials still work, so it can hide the others. Only ever with ids from
 * a list the platform just answered successfully (an empty list after an error would hide every passkey).
 */
export function signalAllAcceptedCredentials(
  rpId: string,
  userId: string,
  credentialIds: string[],
): void {
  if (!rpId || !userId || !canSignal("signalAllAcceptedCredentials")) return;
  void sendSignal({
    signalName: "allAcceptedCredentials",
    rpID: rpId,
    userID: userId,
    allAcceptedCredentialIDs: credentialIds,
  }).catch(() => undefined);
}
