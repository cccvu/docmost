import { afterEach, describe, expect, it, vi } from "vitest";

// #818: the ceremony wrappers turn every browser rejection into a PasskeyError, and the signals are feature-detected
// best-effort calls that never throw.

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  reg: vi.fn(),
  signal: vi.fn(async () => undefined),
  cancel: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: (...a: unknown[]) => m.auth(...a),
  startRegistration: (...a: unknown[]) => m.reg(...a),
  sendSignal: (...a: unknown[]) => m.signal(...(a as [])),
  WebAuthnAbortService: { cancelCeremony: () => m.cancel() },
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => true,
  platformAuthenticatorIsAvailable: async () => true,
}));

import {
  cancelPasskeyCeremony,
  runAuthentication,
  runRegistration,
  signalAllAcceptedCredentials,
  signalUnknownCredential,
} from "./ceremony.ts";
import { PasskeyError } from "./passkey-errors.ts";

const OPTIONS = { challenge: "c" } as never;

afterEach(() => {
  vi.unstubAllGlobals();
  m.auth.mockReset();
  m.reg.mockReset();
  m.signal.mockReset();
  m.signal.mockImplementation(async () => undefined);
});

describe("ceremony wrappers", () => {
  it("pass the options straight through", async () => {
    m.auth.mockResolvedValue({ id: "a" });
    m.reg.mockResolvedValue({ id: "r" });
    expect(await runAuthentication(OPTIONS)).toEqual({ id: "a" });
    expect(m.auth).toHaveBeenCalledWith({
      optionsJSON: OPTIONS,
      useBrowserAutofill: false,
    });
    await runAuthentication(OPTIONS, { autofill: true });
    expect(m.auth).toHaveBeenLastCalledWith({
      optionsJSON: OPTIONS,
      useBrowserAutofill: true,
    });
    expect(await runRegistration(OPTIONS)).toEqual({ id: "r" });
    expect(m.reg).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
  });

  it("wrap rejections as PasskeyError", async () => {
    m.auth.mockRejectedValue(
      Object.assign(new Error("x"), { name: "NotAllowedError" }),
    );
    await expect(runAuthentication(OPTIONS)).rejects.toMatchObject({
      failure: { kind: "cancelled" },
    });
    m.reg.mockRejectedValue(
      Object.assign(new Error("x"), { name: "InvalidStateError" }),
    );
    const e = await runRegistration(OPTIONS).catch((x) => x);
    expect(e).toBeInstanceOf(PasskeyError);
    expect(e.failure).toEqual({ kind: "already-registered" });
  });

  it("cancel delegates to the library's abort service", () => {
    cancelPasskeyCeremony();
    expect(m.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("signals", () => {
  it("are skipped when the browser lacks the method or an id is missing", () => {
    vi.stubGlobal("PublicKeyCredential", {});
    signalUnknownCredential("rp", "cred");
    signalAllAcceptedCredentials("rp", "uid", ["a"]);
    vi.stubGlobal("PublicKeyCredential", {
      signalUnknownCredential: () => undefined,
      signalAllAcceptedCredentials: () => undefined,
    });
    signalUnknownCredential(undefined, "cred");
    signalUnknownCredential("rp", "");
    signalAllAcceptedCredentials("", "uid", ["a"]);
    signalAllAcceptedCredentials("rp", "", ["a"]);
    expect(m.signal).not.toHaveBeenCalled();
  });

  it("are sent and never throw", async () => {
    vi.stubGlobal("PublicKeyCredential", {
      signalUnknownCredential: () => undefined,
      signalAllAcceptedCredentials: () => undefined,
    });
    m.signal.mockRejectedValue(new Error("nope"));
    expect(() => signalUnknownCredential("rp", "cred")).not.toThrow();
    expect(() => signalAllAcceptedCredentials("rp", "uid", [])).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.signal).toHaveBeenCalledWith({
      signalName: "unknownCredential",
      rpID: "rp",
      credentialID: "cred",
    });
    expect(m.signal).toHaveBeenCalledWith({
      signalName: "allAcceptedCredentials",
      rpID: "rp",
      userID: "uid",
      allAcceptedCredentialIDs: [],
    });
  });
});
