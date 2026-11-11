// The extension's `getPageId` comes from collaboration.util, whose module graph pulls tiptap/yjs (lib0 ESM); stub it as
// auth-rate.spec.ts does.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (documentName: string) => documentName.split('.')[1],
}));

import { Hocuspocus } from '@hocuspocus/server';
import { Logger } from '@nestjs/common';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { authFrame, FakeSocket, MSG, readServerFrame } from './collab-ingress.testkit';
import { COLLAB_CONNECTIONS_PER_USER } from './limits';
import { SocketLimitLog } from './socket-limit-log';
import { COLLAB_USER_CONNECTIONS_REASON } from './auth-refusal';
import {
  admitCollabUserConnection,
  CollabUserConnections,
  CollabUserConnectionsExtension,
} from './user-connections';

/**
 * #790: authenticated collab connections per user, per process (COLLAB_CONNECTIONS_PER_USER). Held from Hocuspocus's
 * `connected` to its `onDisconnect`; refused before any read in `onAuthenticate`, and closed at `connected` when
 * concurrent authentications passed that check together.
 */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('#790 CollabUserConnections', () => {
  const make = (cap = 3) => {
    const warn = jest.fn();
    return { warn, c: new CollabUserConnections(cap, new SocketLimitLog({ warn })) };
  };

  it('holds up to the cap per user, refuses past it, frees on release; keys are idempotent; users are separate', () => {
    const { c, warn } = make();
    expect(c.hold('u1', 'a')).toBe(true);
    expect(c.hold('u1', 'a')).toBe(true); // the same connection twice is one
    expect(c.hold('u1', 'b')).toBe(true);
    expect(c.admit('u1')).toBe(true);
    expect(c.hold('u1', 'c')).toBe(true);
    expect(c.admit('u1')).toBe(false);
    expect(c.hold('u1', 'd')).toBe(false);
    expect(c.count('u1')).toBe(3);
    expect(c.hold('u2', 'a')).toBe(true);
    c.release('u1', 'zzz'); // never held: no-op
    c.release('u1', 'a');
    c.release('u1', 'a'); // twice: no-op
    expect(c.count('u1')).toBe(2);
    expect(c.admit('u1')).toBe(true);
    expect(warn.mock.calls.map((x) => x[0])).toEqual(Array(2).fill('COLLAB_SOCKET_LIMIT {"limit":"user_connections","userId":"u1","held":3}'));
  });

  it('admitCollabUserConnection throws { reason } with no message (Hocuspocus logs error.message)', () => {
    const { c } = make(1);
    expect(() => admitCollabUserConnection('u1', c)).not.toThrow();
    c.hold('u1', 'a');
    let thrown: unknown;
    try {
      admitCollabUserConnection('u1', c);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toEqual({ reason: COLLAB_USER_CONNECTIONS_REASON });
    expect(thrown).not.toHaveProperty('message');
  });

  it('is generous enough for many tabs on several devices', () => {
    expect(COLLAB_CONNECTIONS_PER_USER).toBeGreaterThanOrEqual(32);
  });
});

describe('#790 the extension hooks', () => {
  const payload = (user: string | undefined, socketId: string, close = jest.fn(), socketClose = jest.fn()) => ({
    socketId,
    documentName: 'page.p',
    context: user === undefined ? {} : { user: { id: user } },
    connection: { close, webSocket: { close: socketClose } },
  });

  it('holds at connected, releases at onDisconnect; closes (and never holds) a connection past the cap, and its socket', async () => {
    const c = new CollabUserConnections(2, new SocketLimitLog({ warn: () => undefined }));
    const ext = new CollabUserConnectionsExtension(c);
    const closes = [jest.fn(), jest.fn(), jest.fn()];
    const socketCloses = [jest.fn(), jest.fn(), jest.fn()];
    await ext.connected(payload('u1', 's1', closes[0], socketCloses[0]));
    await ext.connected(payload('u1', 's2', closes[1], socketCloses[1]));
    await ext.connected(payload('u1', 's3', closes[2], socketCloses[2]));
    expect(closes.map((f) => f.mock.calls.length)).toEqual([0, 0, 1]);
    expect(closes[2]).toHaveBeenCalledWith({ code: 4429, reason: COLLAB_USER_CONNECTIONS_REASON });
    // the socket too: left open it would hold no document, and a pong would keep it for good
    expect(socketCloses.map((f) => f.mock.calls.length)).toEqual([0, 0, 1]);
    expect(socketCloses[2]).toHaveBeenCalledWith(4429, COLLAB_USER_CONNECTIONS_REASON);
    expect(closes[2].mock.invocationCallOrder[0]).toBeLessThan(socketCloses[2].mock.invocationCallOrder[0]); // the reason first
    expect(c.count('u1')).toBe(2);
    await ext.onDisconnect(payload('u1', 's3')); // the closed one: never held, so nothing is freed
    expect(c.count('u1')).toBe(2);
    await ext.onDisconnect(payload('u1', 's1'));
    expect(c.count('u1')).toBe(1);
  });

  it('ignores a payload with no user (a server DirectConnection) and never throws', async () => {
    const c = new CollabUserConnections(1, new SocketLimitLog({ warn: () => undefined }));
    const ext = new CollabUserConnectionsExtension(c);
    await expect(ext.connected(payload(undefined, 's1'))).resolves.toBeUndefined();
    await expect(ext.onDisconnect({ socketId: 'server', documentName: 'page.p', context: {} })).resolves.toBeUndefined();
    const boom = { socketId: 's', documentName: 'page.p', context: { user: { id: 'u' } }, connection: { close: () => { throw new Error('x'); } } };
    c.hold('u', 'other');
    await expect(ext.connected(boom)).resolves.toBeUndefined();
    expect(c.count('u')).toBe(1);
  });
});

describe('#790 the collab connect refuses a user at the cap before any read', () => {
  afterEach(() => jest.restoreAllMocks());

  it('through AuthenticationExtension: at the cap, onAuthenticate reads nothing', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const user = `cap-${Math.random()}`;
    const userRepo = { findById: jest.fn(async () => undefined) };
    const ext = new AuthenticationExtension(
      { verifyJwt: async (t: string) => ({ sub: t, workspaceId: 'w1', sessionId: 's1' }) } as any,
      userRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const hooks = new CollabUserConnectionsExtension(); // the process-wide registry the extension's check reads
    for (let i = 0; i < COLLAB_CONNECTIONS_PER_USER; i++) {
      await hooks.connected({ socketId: `s${i}`, documentName: 'page.p', context: { user: { id: user } }, connection: { close: jest.fn() } });
    }
    const refused = await ext
      .onAuthenticate({ documentName: 'page.00000000-0000-4000-8000-000000000790', token: user, socketId: 'new', connectionConfig: { readOnly: false } } as any)
      .catch((e: unknown) => e);
    expect(refused).toEqual({ reason: COLLAB_USER_CONNECTIONS_REASON });
    expect(userRepo.findById).not.toHaveBeenCalled();
    await hooks.onDisconnect({ socketId: 's0', documentName: 'page.p', context: { user: { id: user } } });
    await ext
      .onAuthenticate({ documentName: 'page.00000000-0000-4000-8000-000000000790', token: user, socketId: 'new', connectionConfig: { readOnly: false } } as any)
      .catch(() => undefined);
    expect(userRepo.findById).toHaveBeenCalledTimes(1); // a slot freed: the connect proceeds to its reads
    for (let i = 1; i < COLLAB_CONNECTIONS_PER_USER; i++) {
      await hooks.onDisconnect({ socketId: `s${i}`, documentName: 'page.p', context: { user: { id: user } } });
    }
  });
});

describe('#790 through a real Hocuspocus 4.7.1: one user, many sockets', () => {
  const CAP = 3;
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over'); // ends each ClientConnection's timeout timer
    for (const hp of open.splice(0)) hp.closeConnections();
    await settle();
  });

  const server = (connections: CollabUserConnections, delayMs = 0) => {
    const hp = new Hocuspocus({
      quiet: true,
      extensions: [
        new CollabUserConnectionsExtension(connections),
        {
          async onAuthenticate(d: { token: string }) {
            admitCollabUserConnection(d.token, connections); // as authentication.extension.ts does, before its reads
            if (delayMs) await settle(delayMs); // the DB reads, during which other connects run
            return { user: { id: d.token } };
          },
        },
      ],
    } as never);
    open.push(hp);
    return hp;
  };
  const connect = (hp: Hocuspocus, user: string) => {
    const sock = new FakeSocket();
    sockets.push(sock);
    sock.connect(hp);
    sock.deliver(authFrame(user));
    return sock;
  };
  const authenticated = (sock: FakeSocket) => sock.sent.some((f) => readServerFrame(f).type === MSG.Auth) && sock.closeReasons().length === 0;

  it(`the ${CAP + 1}th socket is refused; another user is not; closing a socket frees its slot`, async () => {
    const connections = new CollabUserConnections(CAP, new SocketLimitLog({ warn: () => undefined }));
    const hp = server(connections);
    const socks: FakeSocket[] = [];
    for (let i = 0; i < CAP; i++) {
      socks.push(connect(hp, 'u1'));
      await settle();
    }
    expect(connections.count('u1')).toBe(CAP);
    const extra = connect(hp, 'u1');
    await settle();
    expect(connections.count('u1')).toBe(CAP);
    expect(hp.getConnectionsCount()).toBe(CAP); // the extra one never got a document connection
    connect(hp, 'u2');
    await settle();
    expect(connections.count('u2')).toBe(1);
    socks[0].close(1000, 'tab closed');
    await settle();
    expect(connections.count('u1')).toBe(CAP - 1);
    const again = connect(hp, 'u1');
    await settle();
    expect(connections.count('u1')).toBe(CAP);
    expect(authenticated(again)).toBe(true);
    expect(extra.closed).toBeNull(); // refused in onAuthenticate: the socket stays, under its pre-auth deadline
  });

  it('concurrent connects that all pass the early check are cut back to the cap at connected', async () => {
    const connections = new CollabUserConnections(CAP, new SocketLimitLog({ warn: () => undefined }));
    const hp = server(connections, 20);
    const socks = Array.from({ length: CAP + 4 }, () => connect(hp, 'u1')); // all authenticate at once
    await settle(80);
    expect(connections.count('u1')).toBe(CAP);
    expect(hp.getConnectionsCount()).toBe(CAP);
    const closed = socks.filter((s) => s.closeReasons().includes(COLLAB_USER_CONNECTIONS_REASON));
    expect(closed).toHaveLength(4);
    // each over-cap socket is closed too (it would hold no document), after its reason was sent
    for (const s of closed) expect(s.closed).toEqual({ code: 4429, reason: COLLAB_USER_CONNECTIONS_REASON });
    expect(socks.filter((s) => s.closed === null)).toHaveLength(CAP);
  });

  it('a revalidator-style close of a document connection frees the slot (onDisconnect, not only socket close)', async () => {
    const connections = new CollabUserConnections(CAP, new SocketLimitLog({ warn: () => undefined }));
    const hp = server(connections);
    connect(hp, 'u1');
    await settle();
    expect(connections.count('u1')).toBe(1);
    for (const doc of hp.documents.values()) for (const conn of doc.getConnections()) conn.close({ code: 4403, reason: 'access-revoked' });
    await settle();
    expect(connections.count('u1')).toBe(0);
  });
});
