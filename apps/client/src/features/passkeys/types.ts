import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

// wiki-v2 #818 — NOT upstream Docmost code. The platform's passkey wire shapes (`/auth/passkeys*`,
// `/auth/reauth/passkey/*`), copied from the #818 API contract §1.8. The WebAuthn JSON types themselves come from
// `@simplewebauthn/browser` and are never redefined here.

export interface PasskeyView {
  /** `passkey_credentials.id` (uuid): the DELETE `:id`. Never the credential id. */
  id: string;
  /** base64url credential id, for `PublicKeyCredential.signal*` only. */
  credentialId: string;
  /** uuid; all zeros when the authenticator sent none. */
  aaguid: string;
  /** true → "Synced", false → "This device only". */
  backupEligible: boolean;
  backupState: boolean;
  transports: string[];
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601, or null when never used. */
  lastUsedAt: string | null;
  /** The removal started but the other-device sign-out has not finished: "Removal not finished · Try again". */
  removalPending: boolean;
}

export interface PasskeyListResponse {
  passkeys: PasskeyView[];
  /** last email proof + 90 days (ISO), or null when there is no proof. */
  passkeysWorkUntil: string | null;
  max: number;
  /** The relying party id, for `PublicKeyCredential.signal*`. */
  rpId: string;
  /** base64url WebAuthn user.id, for `signalAllAcceptedCredentials`. */
  userId: string;
}

export interface PasskeySignInResponse {
  id: string;
  email: string;
  workspaceId: string;
  resume?: true;
  /** Present only when the email proof that keeps passkeys working lapses within 30 days (1–30). */
  emailConfirmationDueDays?: number;
}

export type ReauthPasskeyOptions =
  | { available: false }
  | { available: true; options: PublicKeyCredentialRequestOptionsJSON };

export interface RemovePasskeyResponse {
  ok: true;
  platformSessionsRevoked: number;
  wikiSessionsRevoked: number;
}

/** The error body the platform's `/auth/*` routes answer with (Nest's default shape plus a `code`). */
export interface PasskeyErrorBody {
  message?: string | string[];
  code?: string;
  email?: string;
  max_age?: number;
}

/** How "Confirm it's you" may re-prove the person: an emailed code, or a passkey. */
export type ConfirmMethod = "email" | "passkey";
