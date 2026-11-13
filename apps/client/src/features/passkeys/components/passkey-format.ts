import type { Translate } from "@/features/request-errors/request-error.ts";
import { formatLocalized } from "@/lib/date-locale.ts";
import { passkeyProviderLabel } from "../lib/aaguid-labels.ts";
import type { PasskeyView } from "../types.ts";

// wiki-v2 #818 — NOT upstream Docmost code. How Profile → Passkeys names a passkey and shows its dates.

/** The row's name: the provider from the short AAGUID table, else plain "Passkey". */
export function passkeyName(passkey: PasskeyView, t: Translate): string {
  return passkeyProviderLabel(passkey.aaguid) ?? t("Passkey");
}

/** A date for the passkey table and the "works until" line (no time: these are day-scale facts). */
export function passkeyDate(iso: string): string {
  return formatLocalized(iso, "MMM d, yyyy", "PP");
}
