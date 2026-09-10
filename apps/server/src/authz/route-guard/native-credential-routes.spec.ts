import { join } from 'path';
import { scanRoutes } from './static-route-scan';

/**
 * Native-auth fail-closed ALLOWLIST fitness test — NOT upstream Docmost code (seams #87/#88).
 *
 * Pins the server-side native-auth disable (`AUTHZ_MODE=remote`) against silent regression. The guard is a
 * default-deny allowlist: in remote it 404s every route it runs on EXCEPT handlers marked
 * `@SessionScopedRoute()`. The guard unit test (native-auth-mode.guard.spec.ts) proves the guard's behavior on
 * a marked vs unmarked route; this proves the RIGHT routes are (un)marked and guarded on the REAL controllers
 * — which that test can't, because importing the real AuthController drags the fork's `.tsx` email templates
 * through jest (the known moduleNameMapper gap). So we assert it the Layer-C way: a static AST/source scan
 * (static-route-scan.ts), no imports, no boot. (native-auth-http.spec.ts complements this by BOOTING the real
 * controller on Fastify and proving the credential routes actually return 404 in remote.)
 *
 * Load-bearing invariants:
 *  - the session-scoped ALLOWLIST is EXACTLY {collab-token, logout} — a stray add re-opens a native route; a
 *    drop breaks the editor / logout. This is also the ONLY check that catches a class-level-marker fail-open,
 *    so it is kept exact and both-directional;
 *  - NO marker is at the controller-class level (the guard ignores a class marker, but we reject it loudly so
 *    nobody relies on the ignored-but-present state);
 *  - every native `authToken`-minting route THE SCANNER DETECTS (except the fork-owned service-bridge) is
 *    UNDER the guard AND not session-scoped → therefore denied in remote. That closes the invites/accept
 *    class for mints written with the recognized patterns: such a route added without the guard — or wrongly
 *    allowlisted — fails RED here, not in production.
 *
 * SCOPE (honest limits, not a blanket guarantee): the minter invariant is only as complete as the
 * `mintsNativeSession` text heuristic (see static-route-scan.ts). A future handler that establishes a
 * session via an UNRECOGNIZED indirection (a differently-named cookie/helper, or delegating the cookie-set to
 * a service) would be invisible to this scan. `AuthController` is backstopped by the fail-closed class-level
 * guard regardless; other controllers rely on the heuristic — widen `NATIVE_SESSION_MINT_RE` when session
 * issuance changes. Tracked as a known limitation (wiki-v2 issue #139 follow-up).
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src
const SERVICE_BRIDGE_PREFIX = 'service-bridge/'; // fork-owned remote-mode session broker — intentionally native-session-minting

// The EXACT session-scoped allowlist: the only credential-controller routes reachable in remote (they carry
// no native credential). Update DELIBERATELY — this set must equal the ALB `docmost_auth_allow_paths`
// (collab-token + logout). Adding a row exposes a route in remote; removing one denies a needed route.
const EXPECTED_SESSION_SCOPED = ['AuthController.collabToken', 'AuthController.logout'].sort();

describe('native-auth fail-closed allowlist — @SessionScopedRoute() coverage (seams #87/#88)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;

  it('scans a meaningful route set (guards against a silently-empty/broken scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    // The scan must actually see markers/minters, or the assertions below are vacuously green.
    expect(routes.some((r) => r.isSessionScopedRoute)).toBe(true);
    expect(routes.some((r) => r.mintsNativeSession)).toBe(true);
  });

  it('marks EXACTLY the session-scoped allowlist {collab-token, logout} (a stray add or drop fails RED)', () => {
    const marked = routes.filter((r) => r.isSessionScopedRoute).map(key).sort();
    expect(marked).toEqual(EXPECTED_SESSION_SCOPED);
  });

  it('NEVER marks at the controller-class level (a class-level allow is a fail-OPEN hazard)', () => {
    const classLevel = routes.filter((r) => r.isClassLevelSessionScoped).map(key);
    expect(classLevel).toEqual([]);
  });

  it('every allowlisted route is actually under NativeAuthModeGuard (an unguarded "allow" is meaningless)', () => {
    const allowlistedButUnguarded = routes
      .filter((r) => r.isSessionScopedRoute && !r.guardNames.includes('NativeAuthModeGuard'))
      .map((r) => `${key(r)}  (${r.file})`);
    expect(allowlistedButUnguarded).toEqual([]);
  });

  it('EVERY native-session-minting route (except service-bridge) is DENIED in remote — guarded AND not session-scoped', () => {
    const notDenied = routes
      .filter((r) => r.mintsNativeSession && !r.file.startsWith(SERVICE_BRIDGE_PREFIX))
      .filter((r) => !r.guardNames.includes('NativeAuthModeGuard') || r.isSessionScopedRoute)
      .map((r) => `${key(r)}  (${r.file})`);
    // A minter that is NOT under NativeAuthModeGuard, or that IS session-scoped, would establish a native
    // session in remote — the invites/accept class of gap. Put it under @UseGuards(NativeAuthModeGuard) with
    // NO @SessionScopedRoute() (or, if it is genuinely the remote-mode broker, move it under service-bridge/).
    expect(notDenied).toEqual([]);
  });

  it('pins WorkspaceController.acceptInvite as guarded + not session-scoped (seam #88)', () => {
    const accept = routes.find(
      (r) => r.controller === 'WorkspaceController' && r.handler === 'acceptInvite',
    );
    expect(accept?.guardNames).toContain('NativeAuthModeGuard');
    expect(accept?.isSessionScopedRoute).toBe(false);
  });
});
