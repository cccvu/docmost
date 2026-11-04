/**
 * CCC response-header policy — NOT upstream Docmost code (issue #319, #62).
 *
 * The header table, kept separate from the module that installs it so a test can assert the POLICY without
 * booting Fastify, and so adding a header is a one-line data change rather than a wiring change.
 */

/**
 * `Referrer-Policy` — why this value and not a stricter one.
 *
 * The leak this closes: a document URL is sent as the `Referer` of every request the page makes, and some
 * Docmost URLs are worth keeping off third-party origins — a public share is `/share/<key>/p/<slug>`, and a
 * public attachment carries its short-lived `?jwt=` token. The share key is NOT the capability (a published
 * page is addressed by its slug; its controls are unpublish and expiry — ADR 0032), but the URL still names
 * what was shared, so a page that loads or links to a third-party origin should not hand it over.
 * `strict-origin-when-cross-origin` reduces the cross-origin `Referer` to the bare origin.
 *
 * NOT `no-referrer`, deliberately. The platform's `OriginCheckGuard` falls back to the `Referer` header when
 * `Origin` is absent, and `strict-origin-when-cross-origin` keeps the FULL URL on same-origin requests — the
 * only ones that guard inspects. `no-referrer` would strip it everywhere and quietly weaken a CSRF control
 * to buy nothing: what it would additionally hide is the same-origin path, which the origin already implies.
 *
 * This is defense in depth, not the sign-in fix. Modern browsers already default to this value; the header
 * makes it explicit for clients that do not, and states the intent for the next reader. The magic-link token
 * is out of the URL entirely (#319) — a fragment is never sent in `Referer` at all.
 */
export const RESPONSE_SECURITY_HEADERS: ReadonlyArray<
  readonly [string, string]
> = [['Referrer-Policy', 'strict-origin-when-cross-origin']] as const;
