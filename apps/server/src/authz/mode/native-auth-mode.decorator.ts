import { SetMetadata } from '@nestjs/common';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * ALLOWLIST marker for the native-auth mode gate (seams #87/#88). `NativeAuthModeGuard` denies EVERY route
 * it guards when `AUTHZ_MODE=remote` UNLESS the route's handler carries this marker — so the default is
 * fail-CLOSED: a new, unmarked route on a guarded controller (e.g. a future `AuthController` login variant)
 * is 404'd, not silently exposed. Mark ONLY the session-scoped routes that must stay reachable in the
 * integrated deployment: `AuthController`'s `collab-token` (the editor's Hocuspocus token) and `logout`
 * (session revocation). These carry no native credential — they operate on an already-brokered session, and
 * they are exactly the two paths the ALB allow-lists (`docmost_auth_allow_paths`).
 *
 * IMPORTANT — apply this at the HANDLER (method) level ONLY. The guard reads it handler-only
 * (`reflector.get(KEY, getHandler())`), so a marker mistakenly placed on a CONTROLLER CLASS is ignored and
 * the routes stay DENIED (the safe direction — a class-level allow could otherwise re-open the whole
 * controller in remote). The route-inventory fitness test additionally rejects any class-level marker.
 */
export const SESSION_SCOPED_ROUTE_KEY = 'ccc:session-scoped-route';

/**
 * Mark a session-scoped route that stays reachable under `AUTHZ_MODE=remote` (collab-token / logout).
 * Handler-level only (see the class doc above).
 */
export const SessionScopedRoute = () =>
  SetMetadata(SESSION_SCOPED_ROUTE_KEY, true);
