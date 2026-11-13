import { afterEach, describe, expect, it, vi } from "vitest";

// #818 contract §5.1: autofill arms once on mount, re-arms (a new fetch) only on passkey_challenge_expired, never
// after a 429, and disarming cancels only its own open request.

const m = vi.hoisted(() => ({
  signIn: vi.fn(),
  supported: vi.fn(async () => true),
  cancel: vi.fn(),
}));
vi.mock("../services/passkey-api.ts", () => ({
  signInWithPasskey: (...a: unknown[]) => m.signIn(...a),
}));
vi.mock("./capabilities.ts", () => ({
  autofillSupported: () => m.supported(),
}));
vi.mock("./ceremony.ts", () => ({ cancelPasskeyCeremony: () => m.cancel() }));

import { MAX_AUTOFILL_REARMS, armPasskeyAutofill } from "./autofill.ts";
import { PasskeyError, httpFailure } from "./passkey-errors.ts";

const expired = () =>
  new PasskeyError(
    httpFailure("request", 401, { code: "passkey_challenge_expired" }, null),
  );
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  m.signIn.mockReset();
  m.supported.mockImplementation(async () => true);
  m.cancel.mockReset();
});

describe("armPasskeyAutofill", () => {
  it("signs in through the conditional request", async () => {
    const res = { id: "i", email: "a@b.test", workspaceId: "w" };
    m.signIn.mockResolvedValue(res);
    const onSignedIn = vi.fn();
    const onFailure = vi.fn();
    armPasskeyAutofill({ onSignedIn, onFailure });
    await flush();
    expect(m.signIn).toHaveBeenCalledWith({
      autofill: true,
      shouldContinue: expect.any(Function),
    });
    expect(onSignedIn).toHaveBeenCalledWith(res);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does nothing when the browser has no autofill", async () => {
    m.supported.mockImplementation(async () => false);
    armPasskeyAutofill({ onSignedIn: vi.fn(), onFailure: vi.fn() });
    await flush();
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it("re-arms on an expired challenge, up to the bound, then stops quietly", async () => {
    m.signIn.mockRejectedValue(expired());
    const onFailure = vi.fn();
    armPasskeyAutofill({ onSignedIn: vi.fn(), onFailure });
    await flush();
    expect(m.signIn).toHaveBeenCalledTimes(MAX_AUTOFILL_REARMS + 1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("tells the page on each re-arm after an expired challenge (the person picked a passkey too late)", async () => {
    const res = { id: "i", email: "a@b.test", workspaceId: "w" };
    m.signIn.mockRejectedValueOnce(expired()).mockResolvedValueOnce(res);
    const onExpired = vi.fn();
    const onSignedIn = vi.fn();
    const onFailure = vi.fn();
    armPasskeyAutofill({ onSignedIn, onFailure, onExpired });
    await flush();
    expect(onExpired).toHaveBeenCalledTimes(1);
    // Announced BEFORE the new request opens, and the re-arm still happens.
    expect(onExpired.mock.invocationCallOrder[0]).toBeLessThan(
      m.signIn.mock.invocationCallOrder[1],
    );
    expect(m.signIn).toHaveBeenCalledTimes(2);
    expect(onSignedIn).toHaveBeenCalledWith(res);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("announces only the re-arms it makes: never past the bound", async () => {
    m.signIn.mockRejectedValue(expired());
    const onExpired = vi.fn();
    armPasskeyAutofill({ onSignedIn: vi.fn(), onFailure: vi.fn(), onExpired });
    await flush();
    expect(onExpired).toHaveBeenCalledTimes(MAX_AUTOFILL_REARMS);
  });

  it("never re-arms after a 429 (or any other answer): reports it once", async () => {
    const limited = new PasskeyError(
      httpFailure("options", 429, { code: "rate_limited" }, "30"),
    );
    m.signIn.mockRejectedValue(limited);
    const onFailure = vi.fn();
    armPasskeyAutofill({ onSignedIn: vi.fn(), onFailure });
    await flush();
    expect(m.signIn).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(limited.failure);
  });

  it("a cancel is silent", async () => {
    m.signIn.mockRejectedValue(new PasskeyError({ kind: "cancelled" }));
    const onFailure = vi.fn();
    armPasskeyAutofill({ onSignedIn: vi.fn(), onFailure });
    await flush();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("disarm cancels the open request and swallows what it rejects with", async () => {
    let reject: (e: unknown) => void = () => undefined;
    m.signIn.mockImplementation(() => new Promise((_, r) => (reject = r)));
    const onFailure = vi.fn();
    const onSignedIn = vi.fn();
    const disarm = armPasskeyAutofill({ onSignedIn, onFailure });
    await flush();
    disarm();
    disarm();
    expect(m.cancel).toHaveBeenCalledTimes(1);
    reject(
      new PasskeyError(
        httpFailure("request", 401, { code: "passkey_failed" }, null),
      ),
    );
    await flush();
    expect(onFailure).not.toHaveBeenCalled();
    expect(m.signIn).toHaveBeenCalledTimes(1);
  });

  it("hands the api a gate that closes on disarm (the options fetch may still be in flight)", async () => {
    m.signIn.mockImplementation(() => new Promise(() => undefined));
    const disarm = armPasskeyAutofill({
      onSignedIn: vi.fn(),
      onFailure: vi.fn(),
    });
    await flush();
    const { shouldContinue } = m.signIn.mock.calls[0][0] as {
      shouldContinue: () => boolean;
    };
    expect(shouldContinue()).toBe(true);
    disarm();
    expect(shouldContinue()).toBe(false);
  });

  it("disarm before the request opens cancels nothing (another ceremony may own the browser)", async () => {
    const disarm = armPasskeyAutofill({
      onSignedIn: vi.fn(),
      onFailure: vi.fn(),
    });
    disarm();
    await flush();
    expect(m.cancel).not.toHaveBeenCalled();
    expect(m.signIn).not.toHaveBeenCalled();
  });
});
