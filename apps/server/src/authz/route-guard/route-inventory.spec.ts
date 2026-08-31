import { join } from 'path';
import { scanRoutes } from './static-route-scan';
import { classify, guardsAuthenticate } from './route-classification';
import { INTENTIONAL_UNGUARDED, ledgerKey } from './intentional-unguarded.ledger';

/**
 * Layer-C route-inventory FITNESS TEST — NOT upstream Docmost code (GitHub #13).
 *
 * The fork analog of the platform's `route-inventory.spec.ts`. It enumerates EVERY Nest controller route in
 * the fork (by a static AST scan of the source — see static-route-scan.ts) and fails the build if any route
 * carries no authentication decision and is not an explicitly-reasoned ledger entry. This is the structural
 * backstop the fork lacked: a new unguarded single-object GET (the `collab/stats` / `getPublicFile` class of
 * leak — Top Risk #3's UNAUTHENTICATED half) can no longer merge silently.
 *
 * What it does NOT prove: that an AUTHENTICATED single-object read is object-AUTHORIZED (a handler doing
 * `repo.findById(id)` without `validateCanView` classifies as 'authenticated' and passes). That residual is
 * owned by Layer A (the PDP repo rebind) — see route-classification.ts. Green here != "every read is authorized".
 *
 * Ledger contract, asserted as ONE equivalence: the set of routes that are INTRINSIC offenders (unguarded,
 * un-annotated, ledger ignored) must EQUAL the set of ledger keys. So a NEW unguarded route (offender, not
 * ledgered) fails RED, AND a STALE ledger entry (ledgered, no longer an intrinsic offender — route deleted or
 * gained a guard) also fails RED, forcing ledger hygiene.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

describe('Layer C — fork route inventory (no route without an authentication decision)', () => {
  const routes = scanRoutes(SRC_ROOT);

  // Classify each route intrinsically (isLedgered = false) so a ledger entry can't mask an intrinsic
  // offender when we compute hygiene below.
  const intrinsicOffenders = routes.filter(
    (r) =>
      classify({
        isPublic: r.isPublic,
        isForkAuthz: r.isForkAuthz,
        hasAuthGuard: guardsAuthenticate(r.guardNames),
        isLedgered: false,
      }) === 'offender',
  );
  const offenderKey = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;

  it('discovers a meaningful number of controller routes (guards against a silently-empty scan)', () => {
    // A regression that broke the scanner (wrong root, AST shape) would make the whole check vacuous.
    const controllers = new Set(routes.map((r) => r.controller));
    expect(controllers.size).toBeGreaterThanOrEqual(25);
    expect(routes.length).toBeGreaterThanOrEqual(80);
  });

  it('every route is @Public / authenticated / @PlatformAuthz / ledgered — no un-decided route', () => {
    const ledgerKeys = new Set(INTENTIONAL_UNGUARDED.map(ledgerKey));
    const unledgered = intrinsicOffenders.filter((r) => !ledgerKeys.has(offenderKey(r)));
    // A route with no authentication decision and no ledger entry. If you added it: guard it with
    // @UseGuards(JwtAuthGuard) / mark it @PlatformPublic, or (if it is genuinely unguarded on purpose)
    // add a reasoned entry to intentional-unguarded.ledger.ts.
    expect(unledgered.map((r) => `${offenderKey(r)}  (${r.file})`)).toEqual([]);
  });

  it('the ledger has no STALE entries (every entry is an intrinsic offender that still exists)', () => {
    const offenderKeys = new Set(intrinsicOffenders.map(offenderKey));
    const stale = INTENTIONAL_UNGUARDED.filter((e) => !offenderKeys.has(ledgerKey(e)));
    // A ledger entry for a route that no longer exists or now carries a guard — remove it (dead grant).
    expect(stale.map(ledgerKey)).toEqual([]);
  });

  it('every ledger entry has a non-empty reason; every known-gap carries an issue', () => {
    const badReason = INTENTIONAL_UNGUARDED.filter((e) => !e.reason || !e.reason.trim());
    expect(badReason.map(ledgerKey)).toEqual([]);
    const gapWithoutIssue = INTENTIONAL_UNGUARDED.filter((e) => e.mode === 'known-gap' && !e.issue);
    expect(gapWithoutIssue.map(ledgerKey)).toEqual([]);
  });
});
