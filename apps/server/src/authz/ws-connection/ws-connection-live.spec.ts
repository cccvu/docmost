import { isWsConnectionLive } from './ws-connection-live';
import { JwtPayload } from '../../core/auth/dto/jwt-payload';

/**
 * CCC authorization integration test (#455). The notifications-socket liveness gate, factored out of the
 * upstream ws.gateway. It must mirror jwt.strategy: reject a disabled user and a missing/expired/revoked
 * session row, never fail open. Pure unit specs — the repos are fakes, no Nest app / Docker.
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

const repos = (opts: {
  user?: Record<string, unknown> | undefined;
  session?: Record<string, unknown> | undefined;
}) => {
  const userRepo = { findById: jest.fn(async () => opts.user) } as any;
  const userSessionRepo = {
    findActiveById: jest.fn(async () => opts.session),
  } as any;
  return { userRepo, userSessionRepo };
};

const liveUser = { id: SUB, deactivatedAt: null, deletedAt: null };
const liveSession = { id: SID, userId: SUB, workspaceId: WS };

describe('isWsConnectionLive (#455 notifications-socket liveness gate)', () => {
  it('allows a live user with a matching live session', async () => {
    const { userRepo, userSessionRepo } = repos({ user: liveUser, session: liveSession });
    await expect(isWsConnectionLive(userRepo, userSessionRepo, payload())).resolves.toBe(true);
    expect(userRepo.findById).toHaveBeenCalledWith(SUB, WS);
    expect(userSessionRepo.findActiveById).toHaveBeenCalledWith(SID);
  });

  it('rejects a DEACTIVATED user (account disable — the #455 residual it closes)', async () => {
    const { userRepo, userSessionRepo } = repos({
      user: { ...liveUser, deactivatedAt: new Date() },
      session: liveSession,
    });
    await expect(isWsConnectionLive(userRepo, userSessionRepo, payload())).resolves.toBe(false);
    // Fail closed BEFORE consulting the session — a disabled user is out regardless of session state.
    expect(userSessionRepo.findActiveById).not.toHaveBeenCalled();
  });

  it('rejects a DELETED user', async () => {
    const { userRepo, userSessionRepo } = repos({
      user: { ...liveUser, deletedAt: new Date() },
      session: liveSession,
    });
    await expect(isWsConnectionLive(userRepo, userSessionRepo, payload())).resolves.toBe(false);
  });

  it('rejects an unknown user', async () => {
    const { userRepo, userSessionRepo } = repos({ user: undefined, session: liveSession });
    await expect(isWsConnectionLive(userRepo, userSessionRepo, payload())).resolves.toBe(false);
  });

  it('rejects when the session row is revoked/expired/absent (findActiveById returns undefined)', async () => {
    const { userRepo, userSessionRepo } = repos({ user: liveUser, session: undefined });
    await expect(isWsConnectionLive(userRepo, userSessionRepo, payload())).resolves.toBe(false);
  });

  it('rejects a session that belongs to a different user or workspace (defense-in-depth)', async () => {
    const wrongUser = repos({ user: liveUser, session: { ...liveSession, userId: 'someone-else' } });
    await expect(isWsConnectionLive(wrongUser.userRepo, wrongUser.userSessionRepo, payload())).resolves.toBe(false);

    const wrongWs = repos({ user: liveUser, session: { ...liveSession, workspaceId: 'other-ws' } });
    await expect(isWsConnectionLive(wrongWs.userRepo, wrongWs.userSessionRepo, payload())).resolves.toBe(false);
  });

  it('gates on isUserDisabled ONLY when the token carries no sessionId (mirrors jwt.strategy)', async () => {
    const { userRepo, userSessionRepo } = repos({ user: liveUser, session: undefined });
    await expect(
      isWsConnectionLive(userRepo, userSessionRepo, payload({ sessionId: undefined })),
    ).resolves.toBe(true);
    // No sessionId → the session row is never consulted (a legacy ACCESS token rides isUserDisabled alone).
    expect(userSessionRepo.findActiveById).not.toHaveBeenCalled();
  });
});
