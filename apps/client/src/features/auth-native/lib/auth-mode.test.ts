import { afterEach, describe, expect, it } from "vitest";
import { isNativeAuthEnabled } from "./auth-mode";

describe("isNativeAuthEnabled (server-controlled capability)", () => {
  afterEach(() => {
    delete window.CONFIG;
  });

  it("true when the server injected NATIVE_AUTH_ENABLED (boolean true or the string 'true')", () => {
    (window as any).CONFIG = { NATIVE_AUTH_ENABLED: true };
    expect(isNativeAuthEnabled()).toBe(true);
    (window as any).CONFIG = { NATIVE_AUTH_ENABLED: "true" };
    expect(isNativeAuthEnabled()).toBe(true);
  });

  it("false (remote default) when the capability is absent or false", () => {
    expect(isNativeAuthEnabled()).toBe(false); // no window.CONFIG at all
    (window as any).CONFIG = {};
    expect(isNativeAuthEnabled()).toBe(false);
    (window as any).CONFIG = { NATIVE_AUTH_ENABLED: false };
    expect(isNativeAuthEnabled()).toBe(false);
    (window as any).CONFIG = { NATIVE_AUTH_ENABLED: "false" };
    expect(isNativeAuthEnabled()).toBe(false);
  });
});
