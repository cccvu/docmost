import { SetMetadata } from '@nestjs/common';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Metadata key + decorator marking a native, credential-establishing auth route (login / setup /
 * forgot-password / password-reset / verify-token / change-password). `NativeAuthModeGuard` reads this
 * marker and returns 404 for such routes when `AUTHZ_MODE=remote` — for ALL callers, with no exception —
 * so native authentication is disabled server-side (not merely hidden) in the integrated deployment.
 * Session-scoped routes (collab-token / logout) are deliberately NOT marked and stay reachable.
 */
export const NATIVE_CREDENTIAL_ROUTE_KEY = 'ccc:native-credential-route';

/** Mark a native credential-establishing route (see above). */
export const NativeCredentialRoute = () =>
  SetMetadata(NATIVE_CREDENTIAL_ROUTE_KEY, true);
