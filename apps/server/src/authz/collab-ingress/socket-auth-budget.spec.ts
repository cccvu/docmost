import * as decoding from 'lib0/decoding';
import { Hocuspocus } from '@hocuspocus/server';
import { UnauthorizedException } from '@nestjs/common';
import { authFrame, FakeSocket, MSG } from './collab-ingress.testkit';
import { COLLAB_INVALID_TOKEN_REASON, invalidCollabTokenRefusal } from './auth-rate';
import { admitCollabFrame } from './frame-admission';
import { COLLAB_AUTH_FRAMES_PER_SOCKET } from './limits';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #790: a token that does not verify, retried on ONE socket, through a real Hocuspocus 4.7.1 behind the gateway's
 * frame check (wired as the gateway's standalone path wires it). 4.7.1 clears a document's state when it refuses its
 * Auth, so every Auth re-runs `onAuthenticate`; the per-socket Auth budget is what ends the loop. And the refusal
 * carries no `message`, so Hocuspocus logs nothing per attempt, while the client still reads permission-denied.
 */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** The Auth answers the server sent: `permission-denied:<reason>` or `authenticated`. */
function authAnswers(sock: FakeSocket): string[] {
  return sock.sent.flatMap((data) => {
    const d = decoding.createDecoder(data);
    decoding.readVarString(d);
    if (decoding.readVarUint(d) !== MSG.Auth) return [];
    const sub = decoding.readVarUint(d); // 0 Token, 1 PermissionDenied, 2 Authenticated
    return [sub === 1 ? `permission-denied:${decoding.readVarString(d)}` : sub === 2 ? 'authenticated' : `auth:${sub}`];
  });
}

const sockets: FakeSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close(1000, 'test over'); // ends each ClientConnection's timeout timer
});

function setup(refusal: () => unknown, gated: boolean) {
  let calls = 0;
  const hp = new Hocuspocus({
    quiet: true,
    extensions: [
      {
        async onAuthenticate() {
          calls++;
          throw refusal();
        },
      },
    ],
  } as never);
  const sock = new FakeSocket();
  sockets.push(sock);
  const clientConnection = hp.handleConnection(sock as never, new Request('http://localhost/'));
  const limitLog = new SocketLimitLog({ warn: () => undefined });
  sock.on('message', (data: Buffer) => {
    if (gated && !admitCollabFrame(sock, data, limitLog)) return;
    clientConnection.handleMessage(new Uint8Array(data));
  });
  sock.on('close', (code: number, reason: Buffer) => clientConnection.handleClose({ code, reason: reason.toString() }));
  return { hp, sock, calls: () => calls };
}

describe('#790 a token that does not verify, retried on one socket', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => (errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)));
  afterEach(() => jest.restoreAllMocks());

  it('control: without the frame check, every Auth re-runs onAuthenticate and Hocuspocus logs each refusal', async () => {
    const { hp, sock, calls } = setup(() => new UnauthorizedException('Invalid collab token'), false);
    for (let i = 0; i < 3 * COLLAB_AUTH_FRAMES_PER_SOCKET; i++) {
      sock.deliver(authFrame('expired'));
      await settle();
    }
    expect(calls()).toBe(3 * COLLAB_AUTH_FRAMES_PER_SOCKET);
    expect(errors.mock.calls.filter((c) => c[0] === '[onAuthenticate]')).toHaveLength(3 * COLLAB_AUTH_FRAMES_PER_SOCKET);
    expect(sock.closed).toBeNull();
    hp.closeConnections();
  });

  it(`with it: ${COLLAB_AUTH_FRAMES_PER_SOCKET} attempts, then the socket is terminated; nothing is logged per attempt`, async () => {
    const { sock, calls } = setup(invalidCollabTokenRefusal, true);
    for (let i = 0; i < 3 * COLLAB_AUTH_FRAMES_PER_SOCKET; i++) {
      sock.deliver(authFrame('expired'));
      await settle();
    }
    expect(calls()).toBe(COLLAB_AUTH_FRAMES_PER_SOCKET);
    expect(sock.terminated).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    // the client is answered exactly as before: permission-denied, which its auth-failed handler acts on
    expect(authAnswers(sock)).toEqual(Array(COLLAB_AUTH_FRAMES_PER_SOCKET).fill(`permission-denied:${COLLAB_INVALID_TOKEN_REASON}`));
  });

  it('the reason is what Hocuspocus sends for an UnauthorizedException (no reason of its own)', async () => {
    const { hp, sock } = setup(() => new UnauthorizedException('Invalid collab token'), false);
    sock.deliver(authFrame('expired'));
    await settle();
    expect(authAnswers(sock)).toEqual([`permission-denied:${COLLAB_INVALID_TOKEN_REASON}`]);
    hp.closeConnections();
  });
});
