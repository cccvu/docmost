// wiki-v2 #818 — NOT upstream Docmost code. A provider name for the Profile passkey list, from the AAGUID the
// authenticator reported at registration. Deliberately short (six providers, #818 contract §1.8): anything else,
// including the all-zero AAGUID most synced passkeys send, shows as plain "Passkey". The ids were checked against the
// community list (github.com/passkeydeveloper/passkey-authenticator-aaguids, 2026-11-12). Product names are not
// translated.

const LABELS: ReadonlyMap<string, string> = new Map([
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  // The community list now names this one "Apple Passwords"; the contract's label is kept.
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "iCloud Keychain"],
  ["dd4ec289-e01d-41c9-bb89-70fa845d4bf2", "iCloud Keychain"],
  ["08987058-cadc-4b81-b6e1-30de50dcbe96", "Windows Hello"],
  ["9ddd1817-af5a-4672-a2b9-3e3dd95000a9", "Windows Hello"],
  ["6028b017-b1d4-4c02-b4b3-afcdafc96bb2", "Windows Hello"],
  ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
  ["d548826e-79b4-db40-a3d8-11116f7e8349", "Bitwarden"],
  ["adce0002-35bc-c60a-648b-0b25f1f05503", "Chrome on Mac"],
]);

/** The provider's name for this AAGUID, or null (show "Passkey"). */
export function passkeyProviderLabel(
  aaguid: string | null | undefined,
): string | null {
  if (typeof aaguid !== "string") return null;
  return LABELS.get(aaguid.trim().toLowerCase()) ?? null;
}
