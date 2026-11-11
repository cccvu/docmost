import { EventEmitter } from 'node:events';
import * as encoding from 'lib0/encoding';
import { COLLAB_AUTH_RATE_REASON, COLLAB_USER_CONNECTIONS_REASON, invalidCollabTokenRefusal } from './auth-refusal';
import { BoundedCollabSocket } from './bounded-socket';
import { COLLAB_AUTH_BURST } from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';
import { CollabUserConnections } from './user-connections';

/** #810: CollabSocketBounds, the process's collab socket bounds as one object (socket-bounds.ts). */
class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  terminate = jest.fn(() => {
    this.readyState = 3;
  });
  ping = jest.fn();
}
const inner = () => ({ readyState: 1, send: jest.fn(), close: jest.fn() });
const frameFor = (name: string): Buffer => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, name);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 0);
  return Buffer.from(encoding.toUint8Array(e));
};
const quiet = () => new SocketLimitLog({ warn: () => undefined });

describe('#810 CollabSocketBounds.open', () => {
  afterEach(() => jest.useRealTimers());

  it('connect gets the bounded socket over the client; only admitted frames reach forward; a pong touches', () => {
    jest.useFakeTimers();
    const bounds = new CollabSocketBounds({ limitLog: quiet(), pingIntervalMs: 1000 });
    const ws = new FakeWs();
    const touch = jest.fn();
    const forward = jest.fn();
    let handed: unknown;
    const connection = bounds.open(
      ws as never,
      inner(),
      (socket) => {
        handed = socket;
        return { touch };
      },
      forward,
    );
    expect(handed).toBeInstanceOf(BoundedCollabSocket);
    expect((handed as BoundedCollabSocket).rawSocket).toBe(ws);
    const page = frameFor('page.0f8fad5b-d9cb-469f-a165-70867728950e');
    ws.emit('message', page);
    expect(forward.mock.calls).toEqual([[connection, page]]);
    ws.emit('message', frameFor('collabLock:x')); // not page.<uuid>: terminated, never forwarded
    expect(forward).toHaveBeenCalledTimes(1);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    ws.emit('pong');
    expect(touch).toHaveBeenCalledTimes(1);
    ws.readyState = 1;
    jest.advanceTimersByTime(1000);
    expect(ws.ping).toHaveBeenCalledTimes(1); // the keepalive runs at the bounds' interval
    ws.emit('close');
  });
});

describe('#810 the bounds\' refusals carry only a reason (Hocuspocus logs error.message)', () => {
  const thrown = (f: () => void): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('auth rate, user connections and an invalid token: exactly { reason }', () => {
    const bounds = new CollabSocketBounds({ limitLog: quiet(), connections: new CollabUserConnections({ cap: 1, limitLog: quiet() }) });
    for (let i = 0; i < COLLAB_AUTH_BURST; i++) bounds.chargeAuth('u1');
    const rate = thrown(() => bounds.chargeAuth('u1'));
    expect(rate).toEqual({ reason: COLLAB_AUTH_RATE_REASON });
    expect(Object.keys(rate as object)).toEqual(['reason']);

    expect(thrown(() => bounds.admitUser('u1'))).toBeUndefined();
    bounds.connections.hold('u1', 'socket\u0000page');
    const cap = thrown(() => bounds.admitUser('u1'));
    expect(cap).toEqual({ reason: COLLAB_USER_CONNECTIONS_REASON });
    expect(Object.keys(cap as object)).toEqual(['reason']);

    expect(Object.keys(invalidCollabTokenRefusal())).toEqual(['reason']);
  });
});
