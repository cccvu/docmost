// The REAL AuthService cannot load under jest: it imports two `.tsx` email templates, and the moduleNameMapper
// resolves `@docmost/transactional/*` before any mock (so not even a virtual mock reaches them). Stub the module
// as authz/mode/native-auth-http.spec.ts does, so the REAL AuthController loads; AuthService.getCollabToken is
// pinned by a source check below instead.
jest.mock('../../core/auth/services/auth.service', () => ({
  __esModule: true,
  AuthService: class AuthService {},
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../../core/auth/services/token.service';
import { AuthController } from '../../core/auth/auth.controller';
import { JwtType } from '../../core/auth/dto/jwt-payload';

/**
 * CCC authorization test (wiki-v2 #537) — NOT upstream Docmost code.
 *
 * The collab token is bound to the session of the access token that asked for it: `POST /api/auth/collab-token`
 * reads `req.raw.sessionId` (set by `jwt.strategy` from the access token), `AuthService.getCollabToken` passes it
 * through, and `TokenService.generateCollabToken` puts it in the COLLAB payload — or refuses to mint without one.
 * The collab connect then re-checks that session row (`collab-authenticate.spec.ts`, `liveness-parity.spec.ts`).
 */
const SECRET = 'collab-token-session-bound-spec';
const tokens = () =>
  new TokenService(new JwtService({ secret: SECRET }), {
    getAppSecret: () => SECRET,
  } as any);
const user = (over: Record<string, unknown> = {}) =>
  ({
    id: 'u1',
    workspaceId: 'w1',
    deactivatedAt: null,
    deletedAt: null,
    ...over,
  }) as any;

describe('#537 — TokenService.generateCollabToken binds the session', () => {
  it('mints a COLLAB token carrying sub, workspaceId and sessionId, valid for 24h', async () => {
    const svc = tokens();
    const token = await svc.generateCollabToken(user(), 'w1', 'sid-1');
    const claims = await svc.verifyJwt(token, JwtType.COLLAB);
    expect(claims).toEqual(
      expect.objectContaining({
        sub: 'u1',
        workspaceId: 'w1',
        sessionId: 'sid-1',
        type: 'collab',
      }),
    );
    expect(claims.exp - claims.iat).toBe(24 * 60 * 60);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])('refuses to mint with an %s sessionId (Unauthorized)', async (_n, sid) => {
    await expect(
      tokens().generateCollabToken(user(), 'w1', sid as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a disabled user is still Forbidden (the upstream check runs first)', async () => {
    await expect(
      tokens().generateCollabToken(
        user({ deactivatedAt: new Date() }),
        'w1',
        'sid-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('#537 — the session reaches the mint', () => {
  it('AuthService.getCollabToken passes the sessionId through (source check: the module cannot load here)', () => {
    const src = readFileSync(
      join(__dirname, '../../core/auth/services/auth.service.ts'),
      'utf8',
    );
    const method = src.slice(src.indexOf('async getCollabToken('));
    const body = method.slice(0, method.indexOf('\n  }\n'));
    expect(body).toMatch(
      /^async getCollabToken\(\s*user: User,\s*workspaceId: string,\s*sessionId: string,?\s*\)/,
    );
    expect(body).toMatch(
      /generateCollabToken\(\s*user,\s*workspaceId,\s*sessionId,?\s*\)/,
    );
  });

  it("AuthController.collabToken forwards the access token's session (req.raw.sessionId)", async () => {
    const getCollabToken = jest.fn(async () => ({ token: 'tok' }));
    const out = await AuthController.prototype.collabToken.call(
      { authService: { getCollabToken } },
      user(),
      { id: 'w1' } as any,
      { raw: { sessionId: 'sid-1' } } as any,
    );
    expect(out).toEqual({ token: 'tok' });
    expect(getCollabToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'w1',
      'sid-1',
    );
  });

  it('end to end: a request with no session gets no collab token from the real TokenService', async () => {
    const svc = tokens();
    // AuthService.getCollabToken's body (pinned above): a pass-through to the token service.
    const authService = {
      getCollabToken: (u: any, ws: string, sid: string) =>
        svc.generateCollabToken(u, ws, sid).then((token) => ({ token })),
    };
    const call = (raw: Record<string, unknown>) =>
      AuthController.prototype.collabToken.call(
        { authService },
        user(),
        { id: 'w1' } as any,
        { raw } as any,
      );
    await expect(call({})).rejects.toBeInstanceOf(UnauthorizedException);
    const { token } = await call({ sessionId: 'sid-2' });
    expect(await svc.verifyJwt(token, JwtType.COLLAB)).toEqual(
      expect.objectContaining({ sessionId: 'sid-2' }),
    );
  });
});
