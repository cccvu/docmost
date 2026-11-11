// The extension's `getPageId` comes from collaboration.util, whose module graph pulls tiptap/yjs (lib0 ESM); stub it as
// collab-authenticate.spec.ts does. The `@hocuspocus/server` import is type-only and elided.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (documentName: string) => documentName.split('.')[1],
}));

import { Hocuspocus } from '@hocuspocus/server';
import { TokenExpiredError } from 'jsonwebtoken';
import { Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { CollabAuthRate } from './auth-rate';
import {
  COLLAB_AUTH_RATE_REASON,
  COLLAB_INVALID_TOKEN_REASON,
  COLLAB_USER_CONNECTIONS_REASON,
  collabAuthRefusal,
  quietCollabAuthRefusals,
} from './auth-refusal';
import { COLLAB_AUTH_BURST } from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';

/** #790: the per-user collab authentication rate (burst 64, one a second), charged before any read. */
describe('#790 CollabAuthRate', () => {
  const rate = () => {
    const warn = jest.fn();
    return { warn, r: new CollabAuthRate({ limitLog: new SocketLimitLog({ warn }) }) };
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

describe('#790 the collab connect charges the (session) rate after the token verifies and before any read', () => {
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
      new CollabSocketBounds(),
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

  it('the 65th authentication of one session within the window, across sockets, is refused before any repo call', async () => {
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
    expect(warn.mock.calls.map((c) => c[0])).toEqual([`COLLAB_SOCKET_LIMIT {"limit":"auth_session_rate","userId":"${user}"}`]);

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
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // its invalid_token line (pinned below)
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

/**
 * #810 S3: one bucket per SESSION before any read, and the user's bucket only once the session is live. A validly signed
 * collab token of a revoked session (a leaked one lives 24 h) must never be able to keep the user's live sessions
 * refused.
 */
describe('#810 the session is charged before any read, the user only once the session is live', () => {
  const USER = 'u-810';
  const WS = 'w1';
  const PAGE = 'page.00000000-0000-4000-8000-000000000810';
  afterEach(() => jest.restoreAllMocks());

  /** The real extension; `live` holds the sessions that are live. Every token names USER; its text is its session id. */
  const harness = () => {
    const warn = jest.fn();
    const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn }) });
    const live = new Set<string>();
    const userRepo = { findById: jest.fn(async (id: string) => ({ id, workspaceId: WS, deactivatedAt: null, deletedAt: null })) };
    const sessions = {
      findActiveById: jest.fn(async (sid: string) => (live.has(sid) ? { id: sid, userId: USER, workspaceId: WS } : undefined)),
    };
    const pageRepo = { findById: jest.fn(async () => undefined) }; // past both rates the connect reaches this read: 404
    const ext = new AuthenticationExtension(
      { verifyJwt: async (sid: string) => ({ sub: USER, workspaceId: WS, sessionId: sid === 'none' ? undefined : sid }) } as any,
      userRepo as any,
      pageRepo as any,
      { getUserSpaceRoles: jest.fn() } as any,
      { canUserEditPage: jest.fn() } as any,
      sessions as any,
      bounds,
    );
    const reads = () => userRepo.findById.mock.calls.length + sessions.findActiveById.mock.calls.length + pageRepo.findById.mock.calls.length;
    const auth = (sid: string) =>
      ext.onAuthenticate({ documentName: PAGE, token: sid, socketId: 'x', connectionConfig: { readOnly: false } } as any).catch((e: unknown) => e);
    return { bounds, live, warn, reads, pageRepo, auth, ext };
  };

  it('a revoked session drains only its own bucket: a live session of the same user still authenticates', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(20_000_000);
    const h = harness();
    h.live.add('live-B');
    for (let i = 0; i < COLLAB_AUTH_BURST + 10; i++) {
      const r = await h.auth('revoked-A');
      // the first 64 reach the liveness read and are refused there; the rest are over the session's rate
      expect(r).toEqual(i < COLLAB_AUTH_BURST ? expect.any(UnauthorizedException) : { reason: COLLAB_AUTH_RATE_REASON });
    }
    expect(h.bounds.authRate.size).toBe(0); // the revoked session never touched the user's bucket
    const before = h.pageRepo.findById.mock.calls.length;
    expect(await h.auth('live-B')).toBeInstanceOf(NotFoundException); // past both rates and the liveness check
    expect(h.pageRepo.findById.mock.calls.length).toBe(before + 1);
    expect(h.warn.mock.calls.map((c) => c[0])).toEqual(Array(10).fill(`COLLAB_SOCKET_LIMIT {"limit":"auth_session_rate","userId":"${USER}"}`));
  });

  it('two live sessions of one user together are refused at the 65th authentication, after the liveness read', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(21_000_000);
    const h = harness();
    h.live.add('s1');
    h.live.add('s2');
    for (let i = 0; i < COLLAB_AUTH_BURST; i++) expect(await h.auth(i % 2 ? 's1' : 's2')).toBeInstanceOf(NotFoundException);
    const pageReads = h.pageRepo.findById.mock.calls.length;
    const before = h.reads();
    expect(await h.auth('s1')).toEqual({ reason: COLLAB_AUTH_RATE_REASON });
    expect(h.reads()).toBeGreaterThan(before); // the liveness check's reads ran...
    expect(h.pageRepo.findById.mock.calls.length).toBe(pageReads); // ...the page read did not
    expect(h.warn.mock.calls.map((c) => c[0])).toEqual([`COLLAB_SOCKET_LIMIT {"limit":"auth_rate","userId":"${USER}"}`]);
  });

  it('a token naming no session is refused as an invalid token: no read, no bucket, logged by kind only', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      const r = await h.auth('none');
      expect(r).toEqual({ reason: COLLAB_INVALID_TOKEN_REASON });
      expect(Object.keys(r as object)).toEqual(['reason']);
    }
    expect(h.reads()).toBe(0);
    expect(h.bounds.sessionAuthRate.size).toBe(0);
    expect(h.bounds.authRate.size).toBe(0);
    expect(h.warn.mock.calls.map((c) => c[0])).toEqual(Array(3).fill('COLLAB_SOCKET_LIMIT {"limit":"invalid_token","kind":"no_session"}'));
  });

  it('a token that does not verify is logged by kind (expired | invalid), never its token, message or claimed user', async () => {
    const h = harness();
    const ext = new AuthenticationExtension(
      { verifyJwt: async (t: string) => Promise.reject(t === 'old' ? new TokenExpiredError('jwt expired SENTINEL-MSG', new Date(0)) : new Error('invalid signature SENTINEL-MSG')) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      h.bounds,
    );
    for (const token of ['old', 'SENTINEL-TOKEN-u-claimed']) {
      const r = await ext.onAuthenticate({ documentName: PAGE, token, connectionConfig: { readOnly: false } } as any).catch((e: unknown) => e);
      expect(r).toEqual({ reason: COLLAB_INVALID_TOKEN_REASON });
      expect(r).not.toHaveProperty('message');
    }
    const lines = h.warn.mock.calls.map((c) => c[0] as string);
    expect(lines).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"invalid_token","kind":"expired"}',
      'COLLAB_SOCKET_LIMIT {"limit":"invalid_token","kind":"invalid"}',
    ]);
    expect(lines.join('\n')).not.toMatch(/SENTINEL|claimed/);
  });
});

/**
 * #810 L1: the connect's own 4xx refusals are quiet (Hocuspocus logs `[onAuthenticate] <message>` per attempt
 * otherwise); an outage keeps its line.
 */
describe('#810 quietCollabAuthRefusals', () => {
  const warn = jest.fn();
  const log = new SocketLimitLog({ warn });
  beforeEach(() => warn.mockClear());
  const failing = (error: unknown) => ({ onAuthenticate: async (_p: unknown) => Promise.reject(error) });
  const through = (error: unknown) => quietCollabAuthRefusals(failing(error), log).onAuthenticate({}).catch((e: unknown) => e);

  it.each([
    ['UnauthorizedException', new UnauthorizedException(), 401],
    ['NotFoundException', new NotFoundException('Page not found'), 404],
  ])('a %s becomes { reason: permission-denied } (the reason Hocuspocus sent for it), logged with its status only', async (_n, error, status) => {
    const r = await through(error);
    expect(r).toEqual({ reason: COLLAB_INVALID_TOKEN_REASON });
    expect(Object.keys(r as object)).toEqual(['reason']);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"auth_refused","status":${status}}`]]);
  });

  it('an outage passes through unchanged, message and all: a failed read, a 5xx', async () => {
    const boom = new Error('db down');
    expect(await through(boom)).toBe(boom);
    const unavailable = new ServiceUnavailableException('pdp unavailable');
    expect(await through(unavailable)).toBe(unavailable);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a bound\'s { reason } refusal passes through unchanged (it already carries no message, and logs its own line)', async () => {
    for (const reason of [COLLAB_AUTH_RATE_REASON, COLLAB_USER_CONNECTIONS_REASON, COLLAB_INVALID_TOKEN_REASON]) {
      const refusal = collabAuthRefusal(reason);
      expect(await through(refusal)).toBe(refusal);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('an allow passes through with its value (the context Hocuspocus merges)', async () => {
    const ok = { onAuthenticate: async (_p: unknown) => ({ user: { id: 'u' } }) };
    await expect(quietCollabAuthRefusals(ok, log).onAuthenticate({})).resolves.toEqual({ user: { id: 'u' } });
  });

  it('it defines only onAuthenticate and no priority (Hocuspocus keeps the extension where the gateway lists it)', () => {
    expect(Object.keys(quietCollabAuthRefusals(failing(null), log))).toEqual(['onAuthenticate']);
  });

  describe('through a real Hocuspocus 4.7.1 (its hooks() logs `[onAuthenticate] <message>` per refused attempt)', () => {
    let errors: jest.SpyInstance;
    beforeEach(() => (errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)));
    afterEach(() => errors.mockRestore());
    const run = async (extension: unknown) => {
      const hp = new Hocuspocus({ quiet: true, extensions: [extension] } as never);
      await hp.hooks('onAuthenticate', { token: 't' } as never).catch(() => undefined);
      return errors.mock.calls.filter((c) => c[0] === '[onAuthenticate]').length;
    };

    it('control: the bare extension logs one line per refused attempt', async () => {
      expect(await run(failing(new UnauthorizedException()))).toBe(1);
    });

    it('wrapped: a 4xx refusal logs nothing there; an outage still does', async () => {
      expect(await run(quietCollabAuthRefusals(failing(new UnauthorizedException()), log))).toBe(0);
      expect(await run(quietCollabAuthRefusals(failing(new Error('db down')), log))).toBe(1);
    });
  });
});
