import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import platformApi from "@/lib/platform-client.ts";
import {
  runAuthentication,
  runRegistration,
  signalAllAcceptedCredentials,
  signalUnknownCredential,
} from "../lib/ceremony.ts";
import {
  PasskeyError,
  failureFromAxios,
  failureFromResponse,
  shouldSignalUnknownCredential,
} from "../lib/passkey-errors.ts";
import type {
  PasskeyListResponse,
  PasskeySignInResponse,
  PasskeyView,
  ReauthPasskeyOptions,
  RemovePasskeyResponse,
} from "../types.ts";

// wiki-v2 #818 — NOT upstream Docmost code. Every call the wiki makes to the platform's passkey routes.
//
// THE CLICK RULE (Safari's user-gesture rule, #818 contract §5.1). A ceremony function below is called straight from
// a click handler and does exactly ONE native `fetch` for the options, then calls `get()`/`create()` with no other
// await in between (no axios: its adapter adds awaits; no prefetch for a button; no ceremony started from a retry
// after a dialog — a NEW click does it). Axios (`platformApi`) is used only AFTER the ceremony, and for the calls that
// carry no ceremony. All paths are root-relative and same-origin: the platform shares the wiki's origin.

export const PASSKEY_PATHS = {
  signInOptions: "/auth/passkeys/signin/options",
  signInVerify: "/auth/passkeys/signin/verify",
  reauthOptions: "/auth/reauth/passkey/options",
  reauthVerify: "/auth/reauth/passkey/verify",
  list: "/auth/passkeys",
  registrationOptions: "/auth/passkeys/registration/options",
  create: "/auth/passkeys",
  reauthRequest: "/auth/reauth/request",
  reauthCodeVerify: "/auth/reauth/verify",
} as const;

/**
 * The ONE native fetch before a ceremony. A same-origin request carries `Origin` and `Sec-Fetch-Site` itself, which
 * is all the platform's origin check needs. A non-2xx answer or no answer at all is a `PasskeyError` (stage
 * `options`); a 404/405 means an older platform without passkeys.
 */
async function fetchOptions<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
    });
  } catch (error) {
    throw new PasskeyError(
      { kind: "network", stage: "options" },
      { cause: error },
    );
  }
  if (!res.ok)
    throw new PasskeyError(await failureFromResponse(res, "options"));
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw new PasskeyError({ kind: "unknown" }, { cause: error });
  }
}

function requireOptions<O>(body: { options?: O } | null | undefined): O {
  const options = body?.options;
  if (!options || typeof options !== "object") {
    throw new PasskeyError({ kind: "unknown" });
  }
  return options;
}

async function platformCall<T>(call: () => Promise<{ data: T }>): Promise<T> {
  try {
    return (await call()).data;
  } catch (error) {
    throw new PasskeyError(failureFromAxios(error, "request"), {
      cause: error,
    });
  }
}

/**
 * Sign in with a passkey: options → `get()` → verify. Call it straight from the click (or, with `autofill`, on the
 * login page's mount). Only a `401 passkey_not_recognized` from verify tells the browser to drop the credential.
 */
export async function signInWithPasskey(
  opts: { autofill?: boolean; shouldContinue?: () => boolean } = {},
): Promise<PasskeySignInResponse> {
  // `shouldContinue` (synchronous, so the click rule holds) lets the autofill caller stop between steps. Without it a
  // disarm during the options fetch is too early to cancel anything, and the late `get()` then takes the browser's one
  // abort controller from the button's own ceremony; a disarm after `get()` would still sign in with no handler.
  const stopped = () =>
    opts.shouldContinue !== undefined && !opts.shouldContinue();
  const options = requireOptions(
    await fetchOptions<{ options?: PublicKeyCredentialRequestOptionsJSON }>(
      PASSKEY_PATHS.signInOptions,
    ),
  );
  if (stopped()) throw new PasskeyError({ kind: "cancelled" });
  const credential = await runAuthentication(options, {
    autofill: opts.autofill === true,
  });
  if (stopped()) throw new PasskeyError({ kind: "cancelled" });
  try {
    return await platformCall(() =>
      platformApi.post<PasskeySignInResponse>(PASSKEY_PATHS.signInVerify, {
        credential,
      }),
    );
  } catch (error) {
    if (
      error instanceof PasskeyError &&
      shouldSignalUnknownCredential(error.failure)
    ) {
      signalUnknownCredential(options.rpId, credential.id);
    }
    throw error;
  }
}

/**
 * Whether "Use your passkey" can be offered in ConfirmItsYouDialog. A probe, never a ceremony (its challenge is not
 * reused: the click fetches its own). An older platform (404/405) or any failure answers `false`, so the dialog
 * falls back to the emailed code.
 */
export async function probeReauthPasskey(): Promise<boolean> {
  try {
    const { data } = await platformApi.post<ReauthPasskeyOptions>(
      PASSKEY_PATHS.reauthOptions,
      {},
    );
    return data?.available === true;
  } catch {
    return false;
  }
}

/**
 * Re-prove the signed-in person with a passkey (step-up): options → `get()` → verify, which re-mints the platform
 * session with a fresh `auth_time`. `{available:false}` (and an older platform's 404/405) is a `PasskeyError` the
 * error table turns into "use the emailed code".
 */
export async function reauthWithPasskey(): Promise<void> {
  const body = await fetchOptions<ReauthPasskeyOptions>(
    PASSKEY_PATHS.reauthOptions,
  );
  if (!body || body.available !== true) {
    throw new PasskeyError({ kind: "unavailable" });
  }
  const credential = await runAuthentication(requireOptions(body));
  await platformCall(() =>
    platformApi.post<{ ok: true }>(PASSKEY_PATHS.reauthVerify, { credential }),
  );
}

/** Add a passkey: options → `create()` → store. Needs a fresh sign-in and a recent email code (the table's `confirm`). */
export async function registerPasskey(): Promise<PasskeyView> {
  const options = requireOptions(
    await fetchOptions<{ options?: PublicKeyCredentialCreationOptionsJSON }>(
      PASSKEY_PATHS.registrationOptions,
    ),
  );
  const credential = await runRegistration(options);
  const body = await platformCall(() =>
    platformApi.post<{ passkey: PasskeyView }>(PASSKEY_PATHS.create, {
      credential,
    }),
  );
  return body.passkey;
}

/** The signed-in person's passkeys (newest first, including rows whose removal has not finished). */
export async function listPasskeys(): Promise<PasskeyListResponse> {
  return platformCall(() =>
    platformApi.get<PasskeyListResponse>(PASSKEY_PATHS.list),
  );
}

/**
 * After a SUCCESSFUL `listPasskeys()`: tell the browser which credentials still work. A row whose removal is pending
 * no longer works, so it is left out. Takes the list object itself, so it cannot be called with a made-up `[]`.
 */
export function signalAcceptedPasskeys(list: PasskeyListResponse): void {
  if (!list || !Array.isArray(list.passkeys)) return;
  signalAllAcceptedCredentials(
    list.rpId,
    list.userId,
    list.passkeys.filter((p) => !p.removalPending).map((p) => p.credentialId),
  );
}

/**
 * Remove a passkey. The platform also signs the person out on every other device (both planes) before it answers;
 * the wiki makes no revoke call of its own. `503 sign_out_incomplete` → retry the same DELETE.
 */
export async function removePasskey(
  id: string,
): Promise<RemovePasskeyResponse> {
  return platformCall(() =>
    platformApi.delete<RemovePasskeyResponse>(
      `${PASSKEY_PATHS.list}/${encodeURIComponent(id)}`,
    ),
  );
}

/**
 * Step-up by emailed code, step 1: mail a code to the signed-in account's own address. Errors stay axios errors
 * (`reauth_capped`, 429 with Retry-After, 503) for the dialog's code-field messages.
 */
export async function requestReauthCode(): Promise<{ email: string }> {
  const { data } = await platformApi.post<{ email: string }>(
    PASSKEY_PATHS.reauthRequest,
  );
  return data;
}

/** Step-up by emailed code, step 2. A success also records the mailbox proof that keeps passkeys working. */
export async function verifyReauthCode(otp: string): Promise<void> {
  await platformApi.post(PASSKEY_PATHS.reauthCodeVerify, { otp });
}
