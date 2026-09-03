import { join } from 'path';
import { scanRoutes } from './static-route-scan';

/**
 * Native-credential-route FITNESS TEST — NOT upstream Docmost code (seams #87/#88).
 *
 * Pins the server-side native-auth disable (`AUTHZ_MODE=remote`) against silent regression. The guard unit
 * test (native-auth-mode.guard.spec.ts) proves the guard 404s a MARKED route; this proves the RIGHT routes
 * are marked and guarded on the REAL controllers — which that test can't, because importing the real
 * AuthController drags the fork's `.tsx` email templates through jest (the known moduleNameMapper gap). So we
 * assert it the Layer-C way: a static AST/source scan (static-route-scan.ts), no imports, no boot.
 *
 * The load-bearing invariant is the LAST test: every route whose body mints a native `authToken` session must
 * be @NativeCredentialRoute() (except the fork-owned service-bridge, which IS the remote-mode replacement).
 * That is what closes the invites/accept class of gap — a new native-session-minting route added anywhere
 * without the marker fails RED here, not in production.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src
const SERVICE_BRIDGE_PREFIX = 'service-bridge/'; // fork-owned remote-mode session broker — intentionally native-session-minting

// The exact native credential-establishing routes disabled in remote mode. Update DELIBERATELY: adding a row
// means a new native-session route is now gated; removing one means it no longer is (a security decision).
const EXPECTED_MARKED = [
  'AuthController.login',
  'AuthController.setupWorkspace',
  'AuthController.changePassword',
  'AuthController.forgotPassword',
  'AuthController.passwordReset',
  'AuthController.verifyResetToken',
  'WorkspaceController.acceptInvite',
].sort();

describe('native credential routes — @NativeCredentialRoute() coverage (seams #87/#88)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;

  it('scans a meaningful route set (guards against a silently-empty/broken scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    // The scan must actually see markers, or every assertion below is vacuously green.
    expect(routes.some((r) => r.isNativeCredentialRoute)).toBe(true);
    expect(routes.some((r) => r.mintsNativeSession)).toBe(true);
  });

  it('marks EXACTLY the intended native credential routes (a dropped/added marker fails RED)', () => {
    const marked = routes.filter((r) => r.isNativeCredentialRoute).map(key).sort();
    expect(marked).toEqual(EXPECTED_MARKED);
  });

  it('every marked route is actually covered by NativeAuthModeGuard (a marker with no guard is inert)', () => {
    const markedButUnguarded = routes
      .filter((r) => r.isNativeCredentialRoute && !r.guardNames.includes('NativeAuthModeGuard'))
      .map((r) => `${key(r)}  (${r.file})`);
    expect(markedButUnguarded).toEqual([]);
  });

  it('NEVER marks the session-scoped routes (collab-token / logout stay reachable in remote)', () => {
    const collab = routes.find((r) => r.controller === 'AuthController' && r.handler === 'collabToken');
    const logout = routes.find((r) => r.controller === 'AuthController' && r.handler === 'logout');
    expect(collab?.isNativeCredentialRoute).toBe(false);
    expect(logout?.isNativeCredentialRoute).toBe(false);
  });

  it('EVERY native-session-minting route is marked (except the service-bridge) — closes the invites/accept class', () => {
    const unmarkedMinters = routes
      .filter(
        (r) =>
          r.mintsNativeSession &&
          !r.isNativeCredentialRoute &&
          !r.file.startsWith(SERVICE_BRIDGE_PREFIX),
      )
      .map((r) => `${key(r)}  (${r.file})`);
    // A route that mints an authToken session but is not @NativeCredentialRoute(): in remote mode it would
    // establish a native session, bypassing the disable. Mark it @NativeCredentialRoute() + @UseGuards(
    // NativeAuthModeGuard), or (if it is genuinely the remote-mode broker) move it under service-bridge/.
    expect(unmarkedMinters).toEqual([]);
  });
});
