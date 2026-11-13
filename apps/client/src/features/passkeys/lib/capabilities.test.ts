import { afterEach, describe, expect, it, vi } from "vitest";

// #818: browser capability probes answer false instead of throwing, so a passkey control that cannot work hides.

const lib = vi.hoisted(() => ({
  webauthn: vi.fn(() => true),
  autofill: vi.fn(async () => true),
  platform: vi.fn(async () => true),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => lib.webauthn(),
  browserSupportsWebAuthnAutofill: () => lib.autofill(),
  platformAuthenticatorIsAvailable: () => lib.platform(),
}));

import {
  autofillSupported,
  canSignal,
  passkeysSupported,
  platformAuthenticatorAvailable,
} from "./capabilities.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  lib.webauthn.mockImplementation(() => true);
  lib.autofill.mockImplementation(async () => true);
  lib.platform.mockImplementation(async () => true);
});

describe("capabilities", () => {
  it("reports support when the library does", async () => {
    expect(passkeysSupported()).toBe(true);
    expect(await autofillSupported()).toBe(true);
    expect(await platformAuthenticatorAvailable()).toBe(true);
  });

  it("no WebAuthn → nothing else is probed", async () => {
    lib.webauthn.mockImplementation(() => false);
    expect(passkeysSupported()).toBe(false);
    expect(await autofillSupported()).toBe(false);
    expect(await platformAuthenticatorAvailable()).toBe(false);
    expect(lib.autofill).not.toHaveBeenCalled();
  });

  it("a throwing probe is false, never an exception", async () => {
    lib.webauthn.mockImplementation(() => {
      throw new Error("x");
    });
    expect(passkeysSupported()).toBe(false);
    lib.webauthn.mockImplementation(() => true);
    lib.autofill.mockImplementation(async () => {
      throw new Error("x");
    });
    lib.platform.mockImplementation(async () => {
      throw new Error("x");
    });
    expect(await autofillSupported()).toBe(false);
    expect(await platformAuthenticatorAvailable()).toBe(false);
  });

  it("feature-detects each Signal API method", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(canSignal("signalUnknownCredential")).toBe(false);
    vi.stubGlobal("PublicKeyCredential", {
      signalUnknownCredential: () => undefined,
    });
    expect(canSignal("signalUnknownCredential")).toBe(true);
    expect(canSignal("signalAllAcceptedCredentials")).toBe(false);
    vi.stubGlobal("PublicKeyCredential", {
      signalAllAcceptedCredentials: true,
    });
    expect(canSignal("signalAllAcceptedCredentials")).toBe(false);
  });
});
