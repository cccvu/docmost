import { WebSocketServer } from 'ws';
import { COLLAB_WS_SERVER_OPTIONS } from '../../authz/collab-ingress/limits'; // CCC (wiki-v2 #790)
import { CollabSocketBounds } from '../../authz/collab-ingress/socket-bounds'; // CCC (wiki-v2 #790, #810)

export class CollabWsAdapter {
  private readonly wss: WebSocketServer;

  constructor(private readonly collabSocketBounds: CollabSocketBounds) {
    // CCC (wiki-v2 #790, UPSTREAM_MODIFICATIONS): inbound frame bounds; Hocuspocus never configures ws. The upgrade is
    // refused 503 past the process's unauthenticated-socket cap (429 past one client address's share, 400 when the
    // address cannot be keyed: wiki-v2 #810); an admitted one takes its slot in the callback below.
    this.wss = new WebSocketServer({ noServer: true, ...COLLAB_WS_SERVER_OPTIONS, verifyClient: collabSocketBounds.verifyUpgrade });
  }

  handleUpgrade(path: string, httpServer: any) {
    httpServer.on('upgrade', (request: any, socket: any, head: any) => {
      try {
        const baseUrl = 'ws://' + request.headers.host + '/';
        const pathname = new URL(request.url, baseUrl).pathname;

        if (pathname === path) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.collabSocketBounds.holdUpgraded(ws, socket, request); // CCC (wiki-v2 #790, #810): the unauthenticated slot, counting this TCP socket's bytes and against the client address verifyClient keyed this request by
            this.wss.emit('connection', ws, request);
          });
        } else if (pathname === '/socket.io/') {
          return;
        } else {
          socket.destroy();
        }
      } catch (err) {
        socket.end('HTTP/1.1 400\r\n' + (err as Error).message);
      }
    });

    return this.wss;
  }

  public close() {
    try {
      this.wss.close();
    } catch (err) {
      console.error(err);
    }
  }

  public destroy() {
    try {
      this.wss.close();
      this.wss.clients.forEach((client) => {
        client.terminate();
      });
    } catch (err) {
      console.error(err);
    }
  }
}
