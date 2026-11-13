import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

// #818: the passkey api. Pins the click rule (ONE native fetch, then the ceremony, and axios only after it), the
// older-platform answer, and that the browser is told to drop a credential for exactly one answer.

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
vi.mock("@/lib/platform-client.ts", () => ({
  default: {
    post: (...a: unknown[]) => post(...a),
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const startAuthentication = vi.fn();
const startRegistration = vi.fn();
const sendSignal = vi.fn(async () => undefined);
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
  startRegistration: (...a: unknown[]) => startRegistration(...a),
  sendSignal: (...a: unknown[]) => sendSignal(...(a as [])),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => true,
  platformAuthenticatorIsAvailable: async () => true,
}));

import {
  PASSKEY_PATHS,
  listPasskeys,
  probeReauthPasskey,
  reauthWithPasskey,
  registerPasskey,
  removePasskey,
  requestReauthCode,
  signInWithPasskey,
  signalAcceptedPasskeys,
  verifyReauthCode,
} from "./passkey-api.ts";
import { PasskeyError } from "../lib/passkey-errors.ts";

const fetchMock = vi.fn();
const REQUEST_OPTIONS = {
  challenge: "c".repeat(43),
  rpId: "wiki.example.test",
  timeout: 300000,
};
const CREATE_OPTIONS = {
  challenge: "c".repeat(43),
  rp: { name: "Wiki", id: "wiki.example.test" },
  user: { id: "u", name: "a@b.test", displayName: "A" },
  pubKeyCredParams: [],
};
const ASSERTION = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key",
  response: {},
  clientExtensionResults: {},
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function axiosError(status: number, data: unknown) {
  const err = new AxiosError("boom", "ERR_BAD_REQUEST");
  err.response = {
    status,
    statusText: "",
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

async function caught(p: Promise<unknown>): Promise<PasskeyError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PasskeyError);
    return e as PasskeyError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("PublicKeyCredential", {
    signalUnknownCredential: vi.fn(),
    signalAllAcceptedCredentials: vi.fn(),
  });
  startAuthentication.mockResolvedValue(ASSERTION);
  startRegistration.mockResolvedValue({
    ...ASSERTION,
    response: { attestationObject: "x" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fetchMock.mockReset();
  post.mockReset();
  get.mockReset();
  del.mockReset();
  startAuthentication.mockReset();
  startRegistration.mockReset();
});

describe("signInWithPasskey", () => {
  it("does one native same-origin fetch, then get(), and calls axios only after the ceremony", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    post.mockResolvedValue({
      data: { id: "i", email: "a@b.test", workspaceId: "w" },
    });

    const out = await signInWithPasskey();

    expect(out).toEqual({ id: "i", email: "a@b.test", workspaceId: "w" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(PASSKEY_PATHS.signInOptions, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
    });
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: REQUEST_OPTIONS,
      useBrowserAutofill: false,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(PASSKEY_PATHS.signInVerify, {
      credential: ASSERTION,
    });
    // The order IS the rule: fetch < get() < verify, and nothing on axios before get().
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      startAuthentication.mock.invocationCallOrder[0],
    );
    expect(startAuthentication.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("arms the conditional request for autofill", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    post.mockResolvedValue({ data: {} });
    await signInWithPasskey({ autofill: true });
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: REQUEST_OPTIONS,
      useBrowserAutofill: true,
    });
  });

  it("stopped after the options fetch: no get(), so a late start never takes the abort controller", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    let go = true;
    const pending = signInWithPasskey({
      autofill: true,
      shouldContinue: () => go,
    });
    go = false; // disarmed while the options fetch is in flight
    const e = await caught(pending);
    expect(e.failure).toEqual({ kind: "cancelled" });
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("stopped after get(): the credential is never sent to verify (no sign-in nobody handles)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    let go = true;
    startAuthentication.mockImplementation(async () => {
      go = false; // disarmed while the prompt was open
      return ASSERTION;
    });
    const e = await caught(
      signInWithPasskey({ autofill: true, shouldContinue: () => go }),
    );
    expect(e.failure).toEqual({ kind: "cancelled" });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([404, 405])(
    "an older platform (%i on options) starts no ceremony",
    async (status) => {
      fetchMock.mockResolvedValue(
        jsonResponse(status, { message: "Cannot POST", statusCode: status }),
      );
      const e = await caught(signInWithPasskey());
      expect(e.failure).toMatchObject({
        kind: "http",
        stage: "options",
        status,
      });
      expect(startAuthentication).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("a fetch that never answers is a network failure at the options stage", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const e = await caught(signInWithPasskey());
    expect(e.failure).toEqual({ kind: "network", stage: "options" });
  });

  it("a 200 without options is refused, not passed to the browser", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const e = await caught(signInWithPasskey());
    expect(e.failure).toEqual({ kind: "unknown" });
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("a cancelled prompt is a silent failure and never reaches verify", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    startAuthentication.mockRejectedValue(
      Object.assign(new Error("no"), { name: "NotAllowedError" }),
    );
    const e = await caught(signInWithPasskey());
    expect(e.failure).toEqual({ kind: "cancelled" });
    expect(post).not.toHaveBeenCalled();
  });

  it("tells the browser to drop the credential ONLY on 401 passkey_not_recognized", async () => {
    const answers: Array<[number, Record<string, unknown>]> = [
      [401, { code: "passkey_not_recognized" }],
      [401, { code: "passkey_challenge_expired" }],
      [401, { code: "passkey_failed" }],
      [403, { code: "email_confirmation_required", email: "a@b.test" }],
      [400, { code: "passkey_rejected" }],
      [400, { code: "passkey_challenge_stale" }],
      [429, { code: "rate_limited" }],
      [401, { message: "account is not active" }],
      [503, {}],
      [400, { code: "passkey_not_recognized" }],
    ];
    const signalled: string[] = [];
    for (const [status, body] of answers) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { options: REQUEST_OPTIONS }),
      );
      post.mockRejectedValueOnce(axiosError(status, body));
      sendSignal.mockClear();
      await caught(signInWithPasskey());
      if (sendSignal.mock.calls.length)
        signalled.push(`${status} ${String(body.code)}`);
    }
    expect(signalled).toEqual(["401 passkey_not_recognized"]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    post.mockRejectedValueOnce(
      axiosError(401, { code: "passkey_not_recognized" }),
    );
    sendSignal.mockClear();
    await caught(signInWithPasskey());
    expect(sendSignal).toHaveBeenCalledWith({
      signalName: "unknownCredential",
      rpID: "wiki.example.test",
      credentialID: "cred-1",
    });
  });

  it("sends no signal when the browser has no Signal API", async () => {
    vi.stubGlobal("PublicKeyCredential", {});
    fetchMock.mockResolvedValue(
      jsonResponse(200, { options: REQUEST_OPTIONS }),
    );
    post.mockRejectedValue(axiosError(401, { code: "passkey_not_recognized" }));
    const e = await caught(signInWithPasskey());
    expect(e.failure).toMatchObject({
      status: 401,
      code: "passkey_not_recognized",
    });
    expect(sendSignal).not.toHaveBeenCalled();
  });
});

describe("reauthWithPasskey", () => {
  it("does nothing more when the platform says no passkey is available", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { available: false }));
    const e = await caught(reauthWithPasskey());
    expect(e.failure).toEqual({ kind: "unavailable" });
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("fetch → get() → verify, and never signals an unknown credential", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { available: true, options: REQUEST_OPTIONS }),
    );
    post.mockResolvedValue({ data: { ok: true } });
    await reauthWithPasskey();
    expect(fetchMock).toHaveBeenCalledWith(
      PASSKEY_PATHS.reauthOptions,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(post).toHaveBeenCalledWith(PASSKEY_PATHS.reauthVerify, {
      credential: ASSERTION,
    });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      startAuthentication.mock.invocationCallOrder[0],
    );
    expect(startAuthentication.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );

    fetchMock.mockResolvedValue(
      jsonResponse(200, { available: true, options: REQUEST_OPTIONS }),
    );
    post.mockRejectedValue(axiosError(401, { code: "passkey_not_recognized" }));
    await caught(reauthWithPasskey());
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("probe: true only for available:true; an older platform or an error is false", async () => {
    post.mockResolvedValueOnce({
      data: { available: true, options: REQUEST_OPTIONS },
    });
    expect(await probeReauthPasskey()).toBe(true);
    post.mockResolvedValueOnce({ data: { available: false } });
    expect(await probeReauthPasskey()).toBe(false);
    post.mockRejectedValueOnce(axiosError(404, {}));
    expect(await probeReauthPasskey()).toBe(false);
    expect(post).toHaveBeenCalledWith(PASSKEY_PATHS.reauthOptions, {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();
  });
});

describe("registerPasskey", () => {
  it("fetch → create() → store", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { options: CREATE_OPTIONS }));
    const view = { id: "p1", credentialId: "c" };
    post.mockResolvedValue({ data: { passkey: view } });
    expect(await registerPasskey()).toEqual(view);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(PASSKEY_PATHS.registrationOptions);
    expect(startRegistration).toHaveBeenCalledWith({
      optionsJSON: CREATE_OPTIONS,
    });
    expect(post).toHaveBeenCalledWith(PASSKEY_PATHS.create, {
      credential: expect.objectContaining({ id: "cred-1" }),
    });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      startRegistration.mock.invocationCallOrder[0],
    );
    expect(startRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );
  });

  it("a step-up answer on options starts no ceremony", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { code: "step_up_required", max_age: 7200 }),
    );
    const e = await caught(registerPasskey());
    expect(e.failure).toMatchObject({
      status: 403,
      code: "step_up_required",
      stage: "options",
    });
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("InvalidStateError from create() is 'already registered' and stores nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { options: CREATE_OPTIONS }));
    startRegistration.mockRejectedValue(
      Object.assign(new Error("dup"), { name: "InvalidStateError" }),
    );
    const e = await caught(registerPasskey());
    expect(e.failure).toEqual({ kind: "already-registered" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("list, signal, remove, email step-up", () => {
  const list = {
    passkeys: [
      { id: "1", credentialId: "live-1", removalPending: false },
      { id: "2", credentialId: "pending", removalPending: true },
      { id: "3", credentialId: "live-2", removalPending: false },
    ],
    passkeysWorkUntil: null,
    max: 10,
    rpId: "wiki.example.test",
    userId: "uid",
  };

  it("lists through axios and wraps a failure", async () => {
    get.mockResolvedValueOnce({ data: list });
    expect(await listPasskeys()).toBe(list);
    expect(get).toHaveBeenCalledWith(PASSKEY_PATHS.list);
    get.mockRejectedValueOnce(axiosError(503, {}));
    const e = await caught(listPasskeys());
    expect(e.failure).toMatchObject({
      kind: "http",
      status: 503,
      stage: "request",
    });
  });

  it("signals only the credentials that still work", () => {
    signalAcceptedPasskeys(list as never);
    expect(sendSignal).toHaveBeenCalledWith({
      signalName: "allAcceptedCredentials",
      rpID: "wiki.example.test",
      userID: "uid",
      allAcceptedCredentialIDs: ["live-1", "live-2"],
    });
  });

  it("never signals from a list that is not a list", () => {
    signalAcceptedPasskeys(undefined as never);
    signalAcceptedPasskeys({ rpId: "x", userId: "y" } as never);
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("removes by row id, encoded, with no client-side revoke call", async () => {
    del.mockResolvedValue({
      data: { ok: true, platformSessionsRevoked: 1, wikiSessionsRevoked: 2 },
    });
    await removePasskey("a/b");
    expect(del).toHaveBeenCalledWith("/auth/passkeys/a%2Fb");
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("email step-up uses the existing reauth routes", async () => {
    post.mockResolvedValueOnce({ data: { email: "a@b.test" } });
    expect(await requestReauthCode()).toEqual({ email: "a@b.test" });
    expect(post).toHaveBeenLastCalledWith("/auth/reauth/request");
    post.mockResolvedValueOnce({ data: { ok: true } });
    await verifyReauthCode("12345678");
    expect(post).toHaveBeenLastCalledWith("/auth/reauth/verify", {
      otp: "12345678",
    });
  });
});
