import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from '../../core/auth/strategies/jwt.strategy';
import { JwtPayload } from '../../core/auth/dto/jwt-payload';

/**
 * CCC authorization integration test — NOT upstream Docmost code (wiki-v2 #133, seam #160).
 *
 * The `/api/*` access-token verifier: every access token must name a live session of the same user and
 * workspace. A signed token without `sessionId` used to skip the revocable-session check. Repos are fakes.
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

const liveUser = {
  id: SUB,
  workspaceId: WS,
  deactivatedAt: null,
  deletedAt: null,
};
const workspace = { id: WS };
const liveSession = { id: SID, userId: SUB, workspaceId: WS };

const build = (session: Record<string, unknown> | undefined) => {
  const userRepo = { findById: jest.fn(async () => liveUser) } as any;
  const workspaceRepo = { findById: jest.fn(async () => workspace) } as any;
  const userSessionRepo = {
    findActiveById: jest.fn(async () => session),
  } as any;
  const sessionActivityService = { trackActivity: jest.fn() } as any;
  const environmentService = { getAppSecret: () => 'test-app-secret' } as any;
  const strategy = new JwtStrategy(
    userRepo,
    workspaceRepo,
    userSessionRepo,
    sessionActivityService,
    environmentService,
    {} as any,
  );
  return { strategy, userSessionRepo, sessionActivityService };
};

describe('JwtStrategy.validate: access tokens are session-bound (#133)', () => {
  it('rejects an access token without sessionId with 401, even when a live session row exists', async () => {
    const { strategy, userSessionRepo } = build(liveSession);
    const req = { raw: {} } as any;
    await expect(
      strategy.validate(req, payload({ sessionId: undefined })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userSessionRepo.findActiveById).not.toHaveBeenCalled();
    expect(req.raw.sessionId).toBeUndefined();
  });

  it('accepts an access token whose session is active and matches user + workspace', async () => {
    const { strategy, userSessionRepo, sessionActivityService } =
      build(liveSession);
    const req = { raw: {} } as any;
    await expect(strategy.validate(req, payload())).resolves.toEqual({
      user: liveUser,
      workspace,
    });
    expect(userSessionRepo.findActiveById).toHaveBeenCalledWith(SID);
    expect(req.raw.sessionId).toBe(SID);
    expect(sessionActivityService.trackActivity).toHaveBeenCalledWith(
      SID,
      SUB,
      WS,
    );
  });

  it('rejects a revoked, expired or unknown session (no active row) with 401', async () => {
    const { strategy } = build(undefined);
    await expect(
      strategy.validate({ raw: {} } as any, payload()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['a different user', { ...liveSession, userId: 'someone-else' }],
    ['a different workspace', { ...liveSession, workspaceId: 'other-ws' }],
  ])('rejects a session that belongs to %s with 401', async (_n, session) => {
    const { strategy } = build(session);
    await expect(
      strategy.validate({ raw: {} } as any, payload()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
