import { describe, expect, it } from "vitest";
import { passkeyProviderLabel } from "./aaguid-labels.ts";

// #818 contract §1.8: at most six provider labels; anything else is the caller's plain "Passkey".

describe("passkeyProviderLabel", () => {
  it("names the listed providers", () => {
    expect(passkeyProviderLabel("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe(
      "Google Password Manager",
    );
    expect(passkeyProviderLabel("FBFC3007-154E-4ECC-8C0B-6E020557D7BD")).toBe(
      "iCloud Keychain",
    );
    expect(passkeyProviderLabel("6028b017-b1d4-4c02-b4b3-afcdafc96bb2")).toBe(
      "Windows Hello",
    );
    expect(passkeyProviderLabel("bada5566-a7aa-401f-bd96-45619a55120d")).toBe(
      "1Password",
    );
    expect(passkeyProviderLabel("d548826e-79b4-db40-a3d8-11116f7e8349")).toBe(
      "Bitwarden",
    );
    expect(passkeyProviderLabel("adce0002-35bc-c60a-648b-0b25f1f05503")).toBe(
      "Chrome on Mac",
    );
  });

  it("has no label for the zero AAGUID, an unknown one, or prototype keys", () => {
    for (const v of [
      "00000000-0000-0000-0000-000000000000",
      "11111111-2222-3333-4444-555555555555",
      "constructor",
      "__proto__",
      "",
      null,
      undefined,
    ]) {
      expect(passkeyProviderLabel(v)).toBeNull();
    }
  });
});
