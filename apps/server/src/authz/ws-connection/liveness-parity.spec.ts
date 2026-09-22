import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from '../../core/auth/strategies/jwt.strategy';
import { JwtPayload } from '../../core/auth/dto/jwt-payload';
import { isWsConnectionLive } from './ws-connection-live';

/**
 * CCC authorization fitness test (#455).
 *
 * `isWsConnectionLive` (the notifications/collab connect gate) deliberately RE-IMPLEMENTS the liveness core
 * of `jwt.strategy.validate` (the `/api/*` guard): re-read the fork user → reject `isUserDisabled`, then, if
 * the token carries a `sessionId`, re-read the session row and reject a missing / cross-user / cross-ws one.
 * It is a SECURITY predicate where divergence fails OPEN — if the two planes ever disagree, one keeps
 * honoring a revoked identity. A prose "must mirror" comment cannot catch that; THIS test can. It drives the
 * SAME liveness scenarios through BOTH implementations and asserts they agree in lockstep, so changing the
 * liveness rule on one side without the other reds CI.
 *
 * It does NOT touch jwt.strategy's control flow (no regression risk on the hot path) — it constructs the
 * real strategy with fakes and calls `.validate()`. We hold the non-liveness preconditions constant (a
 * present workspace, an ACCESS token, a matching workspaceId) so only the user/session liveness branch
 * varies; that branch is the shared predicate under test.
 */

const SUB = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';

const payload = (over: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: SUB,
  email: 'x@shadow.wiki-v2.internal',
  workspaceId: WS,
  type: 'access',
  sessionId: SID,
  ...over,
});

const liveUser = { id: SUB, deactivatedAt: null, deletedAt: null };
const liveSession = { id: SID, userId: SUB, workspaceId: WS };

// Build both implementations over the SAME fake repos so any behavioural difference is the code, not the data.
const build = (opts: {
  user?: Record<string, unknown> | undefined;
  session?: Record<string, unknown> | undefined;
}) => {
  const userRepo = { findById: jest.fn(async () => opts.user) } as any;
  const userSessionRepo = {
    findActiveById: jest.fn(async () => opts.session),
  } as any;
  const workspaceRepo = { findById: jest.fn(async () => ({ id: WS })) } as any;
  const sessionActivityService = { trackActivity: jest.fn() } as any;
  const environmentService = { getAppSecret: () => 'test-app-secret' } as any;
  const moduleRef = {} as any;
  const strategy = new JwtStrategy(
    userRepo,
    workspaceRepo,
    userSessionRepo,
    sessionActivityService,
    environmentService,
    moduleRef,
  );
  return { userRepo, userSessionRepo, strategy };
};

// Run jwt.strategy.validate and collapse it to the same boolean isWsConnectionLive returns.
const jwtLive = async (strategy: JwtStrategy, p: JwtPayload): Promise<boolean> => {
  try {
    await strategy.validate({ raw: {} } as any, p);
    return true;
  } catch (e) {
    // The liveness branch rejects with UnauthorizedException; surface anything else (would be a test-setup bug).
    if (e instanceof UnauthorizedException) return false;
    throw e;
  }
};

describe('liveness parity: isWsConnectionLive ⇔ jwt.strategy.validate (#455 fail-open guard)', () => {
  const cases: Array<{
    name: string;
    user?: Record<string, unknown> | undefined;
    session?: Record<string, unknown> | undefined;
    payload?: Partial<JwtPayload>;
    expected: boolean;
  }> = [
    { name: 'live user + matching live session', user: liveUser, session: liveSession, expected: true },
    { name: 'live user, no sessionId in token', user: liveUser, session: liveSession, payload: { sessionId: undefined }, expected: true },
    { name: 'DEACTIVATED user', user: { ...liveUser, deactivatedAt: new Date() }, session: liveSession, expected: false },
    { name: 'DELETED user', user: { ...liveUser, deletedAt: new Date() }, session: liveSession, expected: false },
    { name: 'missing user', user: undefined, session: liveSession, expected: false },
    { name: 'sessionId present but session revoked/expired (row absent)', user: liveUser, session: undefined, expected: false },
    { name: 'session belongs to a DIFFERENT user', user: liveUser, session: { ...liveSession, userId: 'other' }, expected: false },
    { name: 'session belongs to a DIFFERENT workspace', user: liveUser, session: { ...liveSession, workspaceId: 'other-ws' }, expected: false },
  ];

  it.each(cases)('agrees on: $name (both → $expected)', async ({ user, session, payload: over, expected }) => {
    const p = payload(over);
    const { userRepo, userSessionRepo, strategy } = build({ user, session });

    const wsVerdict = await isWsConnectionLive(userRepo, userSessionRepo, p);
    const jwtVerdict = await jwtLive(strategy, p);

    // The two planes MUST reach the same liveness decision, and it must be the expected one.
    expect(wsVerdict).toBe(expected);
    expect(jwtVerdict).toBe(expected);
    expect(wsVerdict).toBe(jwtVerdict);
  });
});
