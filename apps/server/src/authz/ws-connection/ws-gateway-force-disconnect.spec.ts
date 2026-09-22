import { WsGateway } from '../../ws/ws.gateway';
import { getUserRoomName } from '../../ws/ws.utils';

/**
 * CCC authorization integration test (#455). Lives in authz/ (CCC-owned) though it exercises the upstream
 * WsGateway seam, mirroring how ws-connection-live.spec.ts / collab-disconnect.controller.spec.ts test the
 * notifications-plane revocation from here.
 *
 * `forceDisconnectUser` must drop a user's LIVE notifications/tree sockets by disconnecting their per-user
 * room (`getUserRoomName`) and CLOSING the underlying connections (`disconnectSockets(true)`). The
 * connect-time `isWsConnectionLive` gate only refuses NEW sockets, so this is what actually cuts an
 * already-open, ping-kept-alive metadata feed on account disable.
 *
 * Only `server` is exercised here; the other constructor deps are irrelevant to this method, so they are
 * left undefined (constructing the gateway just assigns fields — no lifecycle runs).
 */
const newGateway = () =>
  new WsGateway(
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );

describe('WsGateway.forceDisconnectUser (#455 notifications force-close)', () => {
  it('disconnects the user room and closes the underlying sockets', () => {
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn(() => ({ disconnectSockets }));
    const gateway = newGateway();
    (gateway as any).server = { in: inRoom };

    gateway.forceDisconnectUser('user-123');

    expect(inRoom).toHaveBeenCalledWith(getUserRoomName('user-123'));
    // `true` = actually CLOSE the low-level connection, not just leave rooms (so it cannot keep streaming).
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('is a safe no-op before the server is initialised (afterInit not yet run)', () => {
    const gateway = newGateway();
    (gateway as any).server = undefined;
    expect(() => gateway.forceDisconnectUser('user-123')).not.toThrow();
  });
});
