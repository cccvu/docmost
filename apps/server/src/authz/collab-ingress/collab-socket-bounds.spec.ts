import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocketServer } from 'ws';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { PAGE_MAX_YDOC_BYTES, PAGE_MAX_YDOC_BYTES_CEILING } from '../page-write/page-size';
import {
  COLLAB_HOCUSPOCUS_OPTIONS,
  COLLAB_MAX_PAYLOAD_BYTES,
  COLLAB_PREAUTH_HEADROOM_BYTES,
  COLLAB_PREAUTH_SOCKET_BYTES,
  COLLAB_WS_SERVER_OPTIONS,
} from './limits';
import { CollabSocketBounds } from './socket-bounds';

/**
 * #790: the inbound bounds are effective where they are wired. The ws limits through the REAL collab ws adapter
 * (adapter/collab-ws.adapter.ts) on a real HTTP server and a real ws client; the Hocuspocus options on a real
 * Hocuspocus 4.7.1 built with the constant the gateway spreads (gateway-bounds.spec.ts pins that it does).
 */
const MiB = 1024 * 1024;
const PAGE = 'page.0f8fad5b-d9cb-469f-a165-70867728950e';
const RESET_CONNECTION = 4205; // @hocuspocus/common ResetConnection.code

/** A frame of exactly `bytes` bytes: the name, a message type, then padding (Hocuspocus queues it unread). */
function frameOf(bytes: number, name = PAGE, type = 0): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, name);
  encoding.writeVarUint(e, type);
  const head = encoding.toUint8Array(e);
  const out = new Uint8Array(bytes);
  out.set(head);
  return out;
}

describe('#790 ws limits through the collab ws adapter', () => {
  let http: Server;
  let wss: WebSocketServer;
  let adapter: CollabWsAdapter;
  let url: string;
  const received: number[] = [];

  beforeAll(async () => {
    http = createServer();
    const bounds = new CollabSocketBounds();
    adapter = new CollabWsAdapter(bounds);
    wss = adapter.handleUpgrade('/collab', http);
    wss.on('connection', (ws) => {
      // As if it had authenticated: maxPayload is the bound on an authenticated socket (before that, the pre-auth byte
      // count terminates it far sooner: preauth-slots.spec.ts).
      bounds.preAuth.release(ws);
      ws.on('message', (data: Buffer) => received.push(data.byteLength));
      ws.on('error', () => undefined); // collaboration.module.ts logs a client error; ws closes the socket itself
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/collab`;
  });
  afterAll(async () => {
    adapter.destroy();
    await new Promise((r) => http.close(r));
  });
  beforeEach(() => (received.length = 0));

  /** Send one message and report what the server did: the close code, or 'open' once it has been received. */
  async function sendOne(message: Uint8Array): Promise<number | 'open'> {
    const client = new WebSocket(url);
    await new Promise((r, j) => client.once('open', r).once('error', j));
    const closed = new Promise<number>((r) => client.once('close', (code) => r(code)));
    client.on('error', () => undefined);
    client.send(message);
    const outcome = await Promise.race([
      closed,
      (async () => {
        while (received.length === 0) await new Promise((r) => setTimeout(r, 10));
        return 'open' as const;
      })(),
    ]);
    client.terminate();
    return outcome;
  }

  it('the adapter builds its server from COLLAB_WS_SERVER_OPTIONS (8 MiB, 1024 fragments, 65536 chunks, #810: no autoPong, no deflate)', () => {
    expect(wss.options).toMatchObject(COLLAB_WS_SERVER_OPTIONS);
    expect(COLLAB_WS_SERVER_OPTIONS).toEqual({
      maxPayload: 8 * MiB,
      maxFragments: 1024,
      maxBufferedChunks: 65_536,
      autoPong: false,
      perMessageDeflate: false,
    });
    expect(COLLAB_MAX_PAYLOAD_BYTES).toBe(PAGE_MAX_YDOC_BYTES_CEILING);
  });

  it('a message of exactly maxPayload is received', async () => {
    expect(await sendOne(frameOf(COLLAB_MAX_PAYLOAD_BYTES))).toBe('open');
    expect(received).toEqual([COLLAB_MAX_PAYLOAD_BYTES]);
  });

  it('a message of maxPayload + 1 is refused with close 1009 and never delivered', async () => {
    expect(await sendOne(frameOf(COLLAB_MAX_PAYLOAD_BYTES + 1))).toBe(1009);
    expect(received).toEqual([]);
  });

  it('sizing: a page holding near PAGE_MAX_YDOC_BYTES_CEILING of content, re-sent by a client as one update, fits', async () => {
    // a document of paragraphs of text, the shape the editor writes, up to the ceiling less a 16 KiB margin
    const doc = new Y.Doc();
    const root = doc.getXmlFragment('default');
    const line = 'The quick brown fox jumps over the lazy dog. '.repeat(22); // ~1 KiB a paragraph
    doc.transact(() => {
      const paragraphs: Y.XmlElement[] = [];
      for (let i = 0; i < Math.floor((PAGE_MAX_YDOC_BYTES_CEILING - 16 * 1024) / (line.length + 48)); i++) { // ~43 bytes of Yjs structure a paragraph
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText(line)]);
        paragraphs.push(p);
      }
      root.insert(0, paragraphs);
    });
    const update = Y.encodeStateAsUpdate(doc);
    expect(update.byteLength).toBeGreaterThan(PAGE_MAX_YDOC_BYTES_CEILING - 128 * 1024);
    expect(update.byteLength).toBeLessThanOrEqual(PAGE_MAX_YDOC_BYTES_CEILING - 16 * 1024);
    // the client's whole state as one Sync Update frame (y-protocols layout)
    const e = encoding.createEncoder();
    encoding.writeVarString(e, PAGE);
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint8Array(e, update);
    const frame = encoding.toUint8Array(e);
    expect(frame.byteLength - update.byteLength).toBeLessThan(64); // the frame header is a few bytes
    expect(await sendOne(frame)).toBe('open');
    expect(received).toEqual([frame.byteLength]);
    // the configured API cap (default 3 MiB) leaves the editor at least 5 MiB above it
    expect(COLLAB_MAX_PAYLOAD_BYTES - PAGE_MAX_YDOC_BYTES).toBeGreaterThanOrEqual(PAGE_MAX_YDOC_BYTES_CEILING - PAGE_MAX_YDOC_BYTES);
  }, 60_000);
});

describe('#790 Hocuspocus options (a real Hocuspocus 4.7.1 with the gateway constant)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => (warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)));
  afterEach(() => warn.mockRestore());

  function connect(hp: Hocuspocus) {
    const socket = {
      readyState: 1,
      closed: null as number | null,
      send: jest.fn(),
      close(code?: number) {
        if (this.closed !== null) return;
        this.closed = code ?? 1000;
        this.readyState = 3;
      },
    };
    const connection = hp.handleConnection(socket, new Request('http://localhost/'));
    return { socket, deliver: (f: Uint8Array) => connection.handleMessage(f), close: () => connection.handleClose() };
  }

  it('pins the values', () => {
    expect(COLLAB_HOCUSPOCUS_OPTIONS).toEqual({ maxPendingDocuments: 1, maxUnauthenticatedQueueSize: COLLAB_PREAUTH_SOCKET_BYTES });
    expect(COLLAB_PREAUTH_SOCKET_BYTES).toBe(COLLAB_MAX_PAYLOAD_BYTES + COLLAB_PREAUTH_HEADROOM_BYTES); // #810 N5
    expect(COLLAB_PREAUTH_HEADROOM_BYTES).toBe(MiB);
  });

  it('a busy page\'s 512 KiB SyncStep1 and a maximal cached-page update fit in the pre-auth queue (#810 N5); past the cap terminates', () => {
    const hp = new Hocuspocus({ ...COLLAB_HOCUSPOCUS_OPTIONS });
    const c = connect(hp);
    c.deliver(frameOf(512 * 1024)); // a SyncStep1 (the state vector of a page about 75,000 sessions wrote to)
    c.deliver(frameOf(COLLAB_MAX_PAYLOAD_BYTES)); // a cached copy near maxPayload
    expect(c.socket.closed).toBeNull();
    c.deliver(frameOf(COLLAB_PREAUTH_SOCKET_BYTES - 512 * 1024 - COLLAB_MAX_PAYLOAD_BYTES)); // exactly at the cap
    expect(c.socket.closed).toBeNull();
    c.deliver(frameOf(64));
    expect(c.socket.closed).toBe(RESET_CONNECTION);
    c.close();
  });

  it('anti-vacuity: under the upstream default (5 MiB) that maximal frame would terminate', () => {
    const hp = new Hocuspocus({});
    const c = connect(hp);
    c.deliver(frameOf(COLLAB_MAX_PAYLOAD_BYTES - 64));
    expect(c.socket.closed).toBe(RESET_CONNECTION);
    c.close();
  });

  it('one pending document is held; a second terminates the socket (Docmost opens one document per socket)', () => {
    const hp = new Hocuspocus({ ...COLLAB_HOCUSPOCUS_OPTIONS });
    const c = connect(hp);
    const page = (n: number) => `page.0f8fad5b-d9cb-469f-a165-7086772895${String(n).padStart(2, '0')}`;
    c.deliver(frameOf(64, page(0)));
    c.deliver(frameOf(64, page(0)));
    expect(c.socket.closed).toBeNull();
    c.deliver(frameOf(64, page(1)));
    expect(c.socket.closed).toBe(RESET_CONNECTION);
    c.close();
  });
});
