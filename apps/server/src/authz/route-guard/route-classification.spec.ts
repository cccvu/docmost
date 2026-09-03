import { classify, guardsAuthenticate, AUTH_GUARD_NAMES, RouteFacts } from './route-classification';

/**
 * Unit coverage for the shared Layer-C decision function (GitHub #13). This is the single source of truth
 * both the build-time route-inventory fitness test and the runtime PlatformAuthorizationGuard funnel through,
 * so its precedence and its fail-closed default are pinned here directly.
 */
describe('route-classification: classify() precedence + fail-closed default', () => {
  const facts = (o: Partial<RouteFacts>): RouteFacts => ({
    isPublic: false,
    isForkAuthz: false,
    hasAuthGuard: false,
    isLedgered: false,
    ...o,
  });

  it('un-decided facts fail closed to "offender"', () => {
    expect(classify(facts({}))).toBe('offender');
  });

  it('classifies each decided fact', () => {
    expect(classify(facts({ isPublic: true }))).toBe('public');
    expect(classify(facts({ isForkAuthz: true }))).toBe('fork-authz');
    expect(classify(facts({ hasAuthGuard: true }))).toBe('authenticated');
    expect(classify(facts({ isLedgered: true }))).toBe('ledgered');
  });

  it('precedence: public > fork-authz > authenticated > ledgered', () => {
    expect(classify(facts({ isPublic: true, isForkAuthz: true, hasAuthGuard: true, isLedgered: true }))).toBe('public');
    expect(classify(facts({ isForkAuthz: true, hasAuthGuard: true, isLedgered: true }))).toBe('fork-authz');
    expect(classify(facts({ hasAuthGuard: true, isLedgered: true }))).toBe('authenticated');
  });
});

describe('route-classification: the AUTH_GUARD_NAMES allow-list', () => {
  it('recognizes exactly the two authentication guards', () => {
    expect(guardsAuthenticate(['JwtAuthGuard'])).toBe(true);
    expect(guardsAuthenticate(['CollabServiceSecretGuard'])).toBe(true);
    expect(guardsAuthenticate(['ThrottlerGuard', 'SomethingElse'])).toBe(false);
    expect(guardsAuthenticate([])).toBe(false);
  });

  it('the allow-list is a deliberately small, security-sensitive set (pinned exactly)', () => {
    // A regression that widened this set would flip real leaks to false-GREEN — pin it exactly.
    // ServiceAuthGuard authenticates the fork-owned east-west /api/service/* endpoints (session
    // brokerage + provisioning) — scoped, fail-closed, constant-time (see service-bridge/).
    expect([...AUTH_GUARD_NAMES].sort()).toEqual([
      'CollabServiceSecretGuard',
      'JwtAuthGuard',
      'ServiceAuthGuard',
    ]);
  });
});
