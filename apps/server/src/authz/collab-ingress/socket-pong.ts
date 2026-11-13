/**
 * CCC collab integration — NOT upstream Docmost code (#810, ADR 0036).
 *
 * The collab ws server's pong, with at most ONE pong in flight per socket.
 *
 * ws answers every ping by default (`autoPong`), and a pong it cannot write yet waits in the socket's send buffer. A
 * client that pings without reading therefore queues one pong per 6-byte ping it sends: about 210 B of heap each on
 * node:22 (limits.ts), outside every bound (pongs never pass through `BoundedCollabSocket`), so one unauthenticated
 * socket's 9 MiB pre-auth allowance of pings is over 300 MB of heap. COLLAB_WS_SERVER_OPTIONS turns `autoPong` off and
 * this answers instead: a ping while no pong is in flight is answered at once; a ping while one is in flight is kept
 * (the latest only, copied: at most 125 bytes) and answered when that pong has been written (its send callback). RFC
 * 6455 §5.5.3 lets an endpoint answer only the latest of several pings. So a socket holds at most one queued pong and one
 * kept ping, however fast it pings, and a client that reads gets an answer to its latest ping once the pong before it is
 * written, however busy its socket is (a pong waits behind the frames already queued, never for the queue to empty).
 *
 * Browsers never send pings (the server pings them: socket-keepalive.ts), so only non-browser clients see this.
 * Installed for every collab socket at the upgrade (`CollabSocketBounds.holdUpgraded`, seam §226), before ws reads a
 * frame from it. The /socket.io server (engine.io's own ws server) uses it too since #830: its `wsEngine`,
 * RealtimeWsServer (authz/ws-connection/realtime-socket-bounds.ts), turns `autoPong` off and installs this at the upgrade.
 */

/** The `ws` WebSocket surface used here. */
export interface PongSocket {
  on(event: 'ping', listener: (data: Buffer) => void): unknown;
  pong(data: Buffer, mask: boolean, cb: (err?: Error) => void): void;
}

export function answerCollabPings(ws: PongSocket): void {
  let inFlight = false;
  let latest: Buffer | null = null;
  const written = (): void => {
    inFlight = false;
    if (latest === null) return;
    const data = latest;
    latest = null;
    send(data);
  };
  const send = (data: Buffer): void => {
    inFlight = true;
    try {
      ws.pong(data, false, written);
    } catch {
      inFlight = false; // the socket is gone: nothing was queued
    }
  };
  ws.on('ping', (data: Buffer) => {
    // a copy: ws hands over a view of the TCP read, which a kept or queued pong would otherwise hold whole
    const copy = Buffer.from(data);
    if (inFlight) latest = copy;
    else send(copy);
  });
}
