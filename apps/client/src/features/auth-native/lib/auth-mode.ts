/**
 * CCC standalone-mode client helper — NOT upstream Docmost code.
 *
 * The SERVER controls the authorization mode and exposes a derived UI capability, `NATIVE_AUTH_ENABLED`,
 * on `window.CONFIG` (see the server `StaticModule` seam). The client only *reflects* it to pick which
 * sign-in UI to render — it never learns or infers `AUTHZ_MODE` itself, and never derives the mode from
 * request params, headers, cookies, URLs, or client state. Server-side enforcement (native auth routes
 * are disabled in remote mode) is the real boundary; this merely avoids showing a dead form.
 *
 * In dev (Vite serves index.html directly, so the server never injects `window.CONFIG`) it falls back to
 * `import.meta.env.VITE_NATIVE_AUTH_ENABLED`, defaulting to false — the integrated dev stack is remote.
 * The canonical standalone experience runs the built server, which injects the capability.
 *
 * What callers use it for (wiki-v2 #858). Beyond its first meaning (which sign-in, sign-out and session
 * re-mint flow runs), `true`/`false` now also stands for four facts that today move together with the mode:
 *   1. The platform owns the directory: members, groups, invites and space membership (and `users.role` is
 *      inert in remote mode), so native admin UI is hidden there (App.tsx routes, top-menu, settings).
 *   2. A platform exists: request access, the magic-link and passkey sign-in, the Admin Console, feedback,
 *      the site announcement and share expiry (public-auth-buttons, public-footer, the features that call it).
 *   3. The platform owns the remote profile: the Docmost email is a synthetic shadow address, never shown
 *      or edited (account-settings, top-menu), and the name is re-asserted at every sign-in (account-name-form).
 *   4. Docmost sends no mail in remote mode (notification-pref). This one is deploy config, not the mode:
 *      it holds only because the remote task sets no MAIL_DRIVER.
 * If any of these stops matching the mode, split the predicate and re-audit every caller
 * (`grep -rn isNativeAuthEnabled apps/client/src`).
 */
export function isNativeAuthEnabled(): boolean {
  const fromWindow =
    typeof window !== "undefined"
      ? (window.CONFIG as Record<string, unknown> | undefined)?.[
          "NATIVE_AUTH_ENABLED"
        ]
      : undefined;
  const raw =
    fromWindow ??
    (import.meta.env?.VITE_NATIVE_AUTH_ENABLED as unknown);
  return raw === true || raw === "true";
}
