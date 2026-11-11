// collaboration.util pulls tiptap/yjs (lib0 ESM) that jest cannot load; the extension only needs getPageId.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (name: string) => name.split('.')[1],
}));

import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from '../../core/auth/strategies/jwt.strategy';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { CollabSocketBounds } from '../collab-ingress/socket-bounds';
import { JwtPayload } from '../../core/auth/dto/jwt-payload';
import { isWsConnectionLive } from './ws-connection-live';

/**
 * CCC authorization fitness test (#455).
 *
 * `isWsConnectionLive` (the notifications/collab connect gate) deliberately RE-IMPLEMENTS the liveness core
 * of `jwt.strategy.validate` (the `/api/*` guard): re-read the fork user → reject `isUserDisabled`, reject a
 * token with no `sessionId` (#133), then re-read the session row and reject a missing / cross-user / cross-ws one.
 * It is a SECURITY predicate where divergence fails OPEN — if the two planes ever disagree, one keeps
 * honoring a revoked identity. A prose "must mirror" comment cannot catch that; THIS test can. It drives the
 * SAME liveness scenarios through BOTH implementations and asserts they agree in lockstep, so changing the
 * liveness rule on one side without the other reds CI.
 *
 * #537 adds the third plane: the collab (Hocuspocus) connect, `AuthenticationExtension.onAuthenticate`, whose
 * collab token carries the access token's `sessionId`. It is driven for real with the page and permission
 * checks stubbed to allow, so only the liveness branch decides.
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
  sessionRead?: () => Promise<unknown>;
}) => {
  const userRepo = { findById: jest.fn(async () => opts.user) } as any;
  const userSessionRepo = {
    findActiveById: jest.fn(opts.sessionRead ?? (async () => opts.session)),
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

// Run the collab connect (page + permissions stubbed to allow) over the same repos, collapsed to a boolean.
const collabLive = async (userRepo: unknown, userSessionRepo: unknown, p: JwtPayload): Promise<boolean> => {
  const ext = new AuthenticationExtension(
    { verifyJwt: async () => ({ sub: p.sub, workspaceId: p.workspaceId, type: 'collab', sessionId: p.sessionId }) } as any,
    userRepo as any,
    { findById: async () => ({ id: 'p1', spaceId: 's1', deletedAt: null }) } as any,
    { getUserSpaceRoles: async () => [{ userId: SUB, role: 'writer' }] } as any,
    { canUserEditPage: async () => ({ hasAnyRestriction: false, canAccess: true, canEdit: true }) } as any,
    userSessionRepo as any,
    new CollabSocketBounds(),
  );
  try {
    await ext.onAuthenticate({ documentName: 'page.p1', token: 't', connectionConfig: { readOnly: false } } as any);
    return true;
  } catch (e) {
    if (e instanceof UnauthorizedException) return false;
    throw e;
  }
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

describe('liveness parity: isWsConnectionLive ⇔ jwt.strategy.validate ⇔ collab connect (#455, #537 fail-open guard)', () => {
  const cases: Array<{
    name: string;
    user?: Record<string, unknown> | undefined;
    session?: Record<string, unknown> | undefined;
    payload?: Partial<JwtPayload>;
    expected: boolean;
  }> = [
    { name: 'live user + matching live session', user: liveUser, session: liveSession, expected: true },
    // #133: an access token must name a session on both planes; a live user does not rescue one without it.
    { name: 'live user, no sessionId in token', user: liveUser, session: liveSession, payload: { sessionId: undefined }, expected: false },
    { name: 'DEACTIVATED user', user: { ...liveUser, deactivatedAt: new Date() }, session: liveSession, expected: false },
    { name: 'DELETED user', user: { ...liveUser, deletedAt: new Date() }, session: liveSession, expected: false },
    { name: 'missing user', user: undefined, session: liveSession, expected: false },
    { name: 'sessionId present but session revoked/expired (row absent)', user: liveUser, session: undefined, expected: false },
    { name: 'session belongs to a DIFFERENT user', user: liveUser, session: { ...liveSession, userId: 'other' }, expected: false },
    { name: 'session belongs to a DIFFERENT workspace', user: liveUser, session: { ...liveSession, workspaceId: 'other-ws' }, expected: false },
  ];

  it.each(cases)('agrees on: $name (all three → $expected)', async ({ user, session, payload: over, expected }) => {
    const p = payload(over);
    const { userRepo, userSessionRepo, strategy } = build({ user, session });

    const wsVerdict = await isWsConnectionLive(userRepo, userSessionRepo, p);
    const jwtVerdict = await jwtLive(strategy, p);
    const collabVerdict = await collabLive(userRepo, userSessionRepo, p);

    // The three planes MUST reach the same liveness decision, and it must be the expected one.
    expect(wsVerdict).toBe(expected);
    expect(jwtVerdict).toBe(expected);
    expect(collabVerdict).toBe(expected);
    expect(wsVerdict).toBe(jwtVerdict);
    expect(collabVerdict).toBe(jwtVerdict);
  });

  it('a failed session read propagates on every plane (never an allow)', async () => {
    const p = payload();
    const boom = new Error('db down');
    const { userRepo, userSessionRepo, strategy } = build({
      user: liveUser,
      sessionRead: async () => {
        throw boom;
      },
    });
    await expect(isWsConnectionLive(userRepo, userSessionRepo, p)).rejects.toBe(boom);
    await expect(jwtLive(strategy, p)).rejects.toBe(boom);
    await expect(collabLive(userRepo, userSessionRepo, p)).rejects.toBe(boom);
  });
});
