/**
 * CCC Layer-C intentional-unguarded ledger — NOT upstream Docmost code (GitHub #13).
 *
 * The EXPLICIT, reasoned allow-list of routes that carry no authentication decision on purpose. Every route
 * the discovery scan finds must be @Public, guarded by an AUTH_GUARD, carry a fork @PlatformAuthz/@Public,
 * OR appear here — anything else fails the route-inventory fitness test (a new unguarded single-object GET
 * cannot merge). The runtime PlatformAuthorizationGuard reads the SAME ledger, so a ledgered route is allowed
 * at runtime per its `mode`.
 *
 * Keyed by `Controller.handler` (class name + method name) — stable across file moves, matches how offenders
 * are reported. `reason` is mandatory (asserted non-empty); `known-gap` entries must carry an `issue`.
 */

export type UnguardedMode =
  | 'public-infra' // health/robots/app-root/version — public infrastructure, non-sensitive
  | 'public-auth' // pre-authentication endpoints (login, password reset, setup) — no session yet, exist
  //             behind ThrottlerGuard/SetupGuard which are NOT authentication
  | 'signed-token' // gated by a signed one-time token in the request (e.g. attachment ?jwt=), not a session
  | 'workspace-asset' // workspace-scoped public asset (logo/avatar) — no per-page/space authorization
  | 'known-gap'; // a real gap, accepted for now with a linked tracking issue

export interface UnguardedRoute {
  /** Controller CLASS name (e.g. `HealthController`). */
  controller: string;
  /** Handler METHOD name (e.g. `check`). */
  handler: string;
  mode: UnguardedMode;
  reason: string;
  /** Required for `mode: 'known-gap'` — the tracking issue for the real fix. */
  issue?: string;
}

export const INTENTIONAL_UNGUARDED: readonly UnguardedRoute[] = [
  // --- public infrastructure / public-by-design content (anonymous access intended) ---
  {
    controller: 'AppController',
    handler: 'getHello',
    mode: 'public-infra',
    reason: 'App root (GET /) — non-sensitive hello/liveness; also the CollabAppModule root.',
  },
  {
    controller: 'HealthController',
    handler: 'check',
    mode: 'public-infra',
    reason: 'GET /health — infra readiness probe; no sensitive data.',
  },
  {
    controller: 'HealthController',
    handler: 'checkLive',
    mode: 'public-infra',
    reason: 'GET /health/live — infra liveness probe; no sensitive data.',
  },
  {
    controller: 'RobotsTxtController',
    handler: 'robotsTxt',
    mode: 'public-infra',
    reason: 'GET /robots.txt — public SEO artifact, non-/api.',
  },
  {
    controller: 'ShareSeoController',
    handler: 'getShare',
    mode: 'public-infra',
    reason:
      'Public shared-page SEO — Docmost share feature is public-by-design; ShareService authorizes on the ' +
      'share row existing/enabled, the public share link is the capability. No session.',
  },

  // --- pre-authentication endpoints (no session exists yet; ThrottlerGuard/SetupGuard are NOT auth) ---
  {
    controller: 'AuthController',
    handler: 'login',
    mode: 'public-auth',
    reason: 'POST /auth/login — establishes the session; pre-auth by definition. Rate-limited (ThrottlerGuard).',
  },
  {
    controller: 'AuthController',
    handler: 'setupWorkspace',
    mode: 'public-auth',
    reason: 'POST /auth/setup — one-time workspace bootstrap, gated by SetupGuard (allowed only pre-setup).',
  },
  {
    controller: 'AuthController',
    handler: 'forgotPassword',
    mode: 'public-auth',
    reason: 'POST /auth/forgot-password — pre-auth recovery start; rate-limited (ThrottlerGuard).',
  },
  {
    controller: 'AuthController',
    handler: 'passwordReset',
    mode: 'public-auth',
    reason: 'POST /auth/password-reset — completes reset via an emailed token; pre-auth. Rate-limited.',
  },
  {
    controller: 'AuthController',
    handler: 'verifyResetToken',
    mode: 'public-auth',
    reason: 'POST /auth/verify-token — validates an emailed reset token; pre-auth. Rate-limited.',
  },

  // --- self-gating asset endpoints (their own token / scope, not a session) ---
  {
    controller: 'AttachmentController',
    handler: 'getPublicFile',
    mode: 'signed-token',
    reason:
      'GET /files/public/:fileId/:fileName — gated by a signed ?jwt= attachment token verified against ' +
      'attachmentId + workspaceId + pageId; the token is the capability, not a session.',
  },
  {
    controller: 'AttachmentController',
    handler: 'getLogoOrAvatar',
    mode: 'workspace-asset',
    reason: 'GET /attachments/img/:type/:fileName — workspace-scoped public branding asset (logo/avatar).',
  },

  // --- known gaps (accepted for now, tracked) ---
  {
    controller: 'CollaborationController',
    handler: 'getStats',
    mode: 'known-gap',
    reason:
      'GET /collab/stats leaks aggregate connection/document counts unauthenticated. Low severity: it lives ' +
      'in the SEPARATE CollabAppModule process (unreachable by the main-app global guard) and is env-gated ' +
      'behind COLLAB_SHOW_STATS (off by default), returning only counts. Real fix tracked in the issue.',
    issue: 'https://github.com/cccvu/wiki-v2/issues/80',
  },
];

export const ledgerKey = (r: Pick<UnguardedRoute, 'controller' | 'handler'>): string =>
  `${r.controller}.${r.handler}`;
