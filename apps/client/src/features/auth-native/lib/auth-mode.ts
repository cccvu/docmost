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
