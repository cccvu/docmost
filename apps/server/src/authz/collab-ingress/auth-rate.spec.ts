// The extension's `getPageId` comes from collaboration.util, whose module graph pulls tiptap/yjs (lib0 ESM); stub it as
// collab-authenticate.spec.ts does. The `@hocuspocus/server` import is type-only and elided.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (documentName: string) => documentName.split('.')[1],
}));

import { Logger, UnauthorizedException } from '@nestjs/common';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { COLLAB_AUTH_RATE_REASON, COLLAB_INVALID_TOKEN_REASON, CollabAuthRate } from './auth-rate';
import { COLLAB_AUTH_BURST } from './limits';
import { SocketLimitLog } from './socket-limit-log';

/** #790: the per-user collab authentication rate (burst 64, one a second), charged before any read. */
describe('#790 CollabAuthRate', () => {
  const rate = () => {
    const warn = jest.fn();
    return { warn, r: new CollabAuthRate(new SocketLimitLog({ warn })) };
  };

  it('admits a burst of 64 for one user, refuses the 65th, and leaves another user alone', () => {
    const { r, warn } = rate();
    const t = 1_000_000;
    for (let i = 0; i < COLLAB_AUTH_BURST; i++) expect(r.charge('u1', t)).toBe(true);
    expect(r.charge('u1', t)).toBe(false);
    expect(r.charge('u2', t)).toBe(true);
    expect(warn.mock.calls).toEqual([['COLLAB_SOCKET_LIMIT {"limit":"auth_rate","userId":"u1"}']]);
  });

  it('refills one a second, never past the burst, and a refusal costs nothing', () => {
    const { r } = rate();
    const t = 1_000_000;
    for (let i = 0; i < COLLAB_AUTH_BURST; i++) r.charge('u1', t);
    expect(r.charge('u1', t + 999)).toBe(false);
    expect(r.charge('u1', t + 1000)).toBe(true);
    expect(r.charge('u1', t + 1000)).toBe(false);
    // a sweep at t+60 s keeps u1 (60 tokens, not full); idle to t+119 s with no sweep since: a full burst, not 119
    r.charge('other', t + 60_000);
    expect(r.size).toBe(2);
    const later = t + 119_000;
    let admitted = 0;
    while (r.charge('u1', later)) admitted++;
    expect(admitted).toBe(COLLAB_AUTH_BURST);
  });

  it('drops a bucket that has refilled to full (at most one sweep a minute)', () => {
    const { r } = rate();
    const t = 1_000_000;
    r.charge('idle', t);
    for (let i = 0; i < COLLAB_AUTH_BURST; i++) r.charge('busy', t + 30_000);
    expect(r.size).toBe(2);
    r.charge('other', t + 61_000); // sweeps: `idle` is full again, `busy` (empty 31 s ago) is not
    expect(r.size).toBe(2);
    r.charge('other', t + 62_000); // within the minute: no sweep
    expect(r.size).toBe(2);
    r.charge('other', t + 125_000); // sweeps: all full
    expect(r.size).toBe(1);
  });
});

describe('#790 the collab connect charges the rate after the token verifies and before any read', () => {
  afterEach(() => jest.restoreAllMocks());

  const repos = () => {
    const userRepo = { findById: jest.fn(async () => undefined) };
    const pageRepo = { findById: jest.fn() };
    const spaceMemberRepo = { getUserSpaceRoles: jest.fn() };
    const pagePermissionRepo = { canUserEditPage: jest.fn() };
    const sessions = { findActiveById: jest.fn() };
    let verify = jest.fn(async (token: string) => ({ sub: token, workspaceId: 'w1', sessionId: 's1' }));
    const ext = new AuthenticationExtension(
      { verifyJwt: (t: string) => verify(t) } as any,
      userRepo as any,
      pageRepo as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
      sessions as any,
    );
    const reads = () =>
      userRepo.findById.mock.calls.length +
      pageRepo.findById.mock.calls.length +
      spaceMemberRepo.getUserSpaceRoles.mock.calls.length +
      pagePermissionRepo.canUserEditPage.mock.calls.length +
      sessions.findActiveById.mock.calls.length;
    const setVerify = (f: typeof verify) => (verify = f);
    return { ext, userRepo, reads, setVerify };
  };
  // the token names the user (verifyJwt is stubbed to return { sub: token }); each attempt comes from its own socket
  const attempt = (ext: AuthenticationExtension, user: string, socket: number) =>
    ext.onAuthenticate({
      documentName: 'page.00000000-0000-4000-8000-000000000790',
      token: user,
      socketId: `socket-${socket}`,
      connectionConfig: { readOnly: false },
    } as any);

  it('the 65th authentication of one user within the window, across sockets, is refused before any repo call', async () => {
    let now = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { ext, userRepo, reads } = repos();
    const user = `rate-${Math.random()}`;
    for (let i = 0; i < COLLAB_AUTH_BURST; i++) {
      await expect(attempt(ext, user, i)).rejects.toBeInstanceOf(UnauthorizedException); // no such user: a read ran
    }
    expect(userRepo.findById).toHaveBeenCalledTimes(COLLAB_AUTH_BURST);
    const before = reads();

    const refused = await attempt(ext, user, 999).catch((e: unknown) => e);
    expect(refused).toEqual({ reason: COLLAB_AUTH_RATE_REASON });
    expect(refused).not.toHaveProperty('message'); // Hocuspocus logs error.message; nothing extra is logged
    expect(reads()).toBe(before);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([`COLLAB_SOCKET_LIMIT {"limit":"auth_rate","userId":"${user}"}`]);

    // another user is unaffected
    await expect(attempt(ext, `other-${Math.random()}`, 1000)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(reads()).toBe(before + 1);

    // the refill restores one attempt a second
    now += 1000;
    await expect(attempt(ext, user, 1001)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(reads()).toBe(before + 2);
    await expect(attempt(ext, user, 1002)).rejects.toEqual({ reason: COLLAB_AUTH_RATE_REASON });
    expect(reads()).toBe(before + 2);
  });

  it('a token that does not verify is refused without charging anyone, and with no message Hocuspocus would log', async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => 9_000_000);
    const { ext, setVerify, reads } = repos();
    const user = `bad-${Math.random()}`;
    setVerify(jest.fn(async (_t: string) => Promise.reject(new Error("bad token"))));
    for (let i = 0; i < COLLAB_AUTH_BURST + 5; i++) {
      const refused = await attempt(ext, user, i).catch((e: unknown) => e);
      // exactly the reason Hocuspocus sends for a refusal that names none, so the client sees what it always saw
      expect(refused).toEqual({ reason: COLLAB_INVALID_TOKEN_REASON });
      expect(refused).not.toHaveProperty('message');
    }
    expect(reads()).toBe(0);
    setVerify(jest.fn(async (t: string) => ({ sub: t, workspaceId: 'w1', sessionId: 's1' })));
    await expect(attempt(ext, user, 0)).rejects.toBeInstanceOf(UnauthorizedException); // charged now, a read ran
    expect(reads()).toBe(1);
  });
});
