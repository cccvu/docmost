/**
 * CCC authorization integration — NOT upstream Docmost code (#781, ADR 0036).
 *
 * Shared helpers for the collab-ingress specs: Hocuspocus 4.7.1 wire frames, a remote Yjs client, a peer that renders
 * with the editor's own binding (@tiptap/y-tiptap 3.0.5, the library every browser runs), and a fixture holding every
 * node and mark of the server schema. NOT a jest suite and not built (`.testkit.ts`, see tsconfig.build.json).
 */
import { EventEmitter } from 'node:events';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import { TiptapTransformer } from '@hocuspocus/transformer';
import type { Hocuspocus } from '@hocuspocus/server';
import { serverSchema } from '../page-write/prelim-content';
import { deadlineExceeded, runWithDeadline, type DeadlineRunner } from './deadline';

export const DOC_NAME = 'page.00000000-0000-4000-8000-000000000781';

/**
 * #827: the CPU this jest worker ran, in ms (user + system, every thread of the process). The guard charges its CPU
 * budget and decides its deadlines on wall time, which on a production task (one process, its own vCPUs) is the
 * work's cost. On a shared CI runner (`--maxWorkers=2` on mixed tiers, #567) wall time also counts the time the worker
 * waited for a core, so a spec that asserts an honest frame fits a bound measures the frame in CPU time instead: a
 * slower CPU still costs more and still fails, a busy neighbour no longer does.
 */
export const processCpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/**
 * #827: the guard's deadline runner for specs asserting honest work fits the PRODUCTION deadlines: the real vm deadline
 * still runs (at `wallSlack` × the bound, so runaway work is still cut), and work that finished is the guard's timeout
 * when it used more than the bound in CPU time (`processCpuMs`). Same verdict as production's for an honest frame on a
 * host with a free core; never a looser bound on the work itself.
 */
export function cpuTimeDeadline(wallSlack = 10): DeadlineRunner {
  return <T>(fn: () => T, ms: number): T => {
    const started = processCpuMs();
    const result = runWithDeadline(fn, ms * wallSlack);
    if (processCpuMs() - started > ms) throw deadlineExceeded(ms);
    return result;
  };
}

/** Hocuspocus 4.7.1 message types (`types.ts` MessageType) and y-protocols sync subtypes. */
export const MSG = { Sync: 0, Awareness: 1, Auth: 2, QueryAwareness: 3, SyncReply: 4, Stateless: 5, BroadcastStateless: 6, Close: 7, SyncStatus: 8 } as const;
export const SYNC = { Step1: 0, Step2: 1, Update: 2 } as const;

const frame = (write: (e: encoding.Encoder) => void, docName = DOC_NAME): Uint8Array => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, docName);
  write(e);
  return encoding.toUint8Array(e);
};

/** A Sync (or SyncReply) frame carrying a Yjs V1 update as Step2 or Update. */
export const syncFrame = (update: Uint8Array, subtype: number = SYNC.Update, type: number = MSG.Sync, docName = DOC_NAME): Uint8Array =>
  frame((e) => {
    encoding.writeVarUint(e, type);
    encoding.writeVarUint(e, subtype);
    encoding.writeVarUint8Array(e, update);
  }, docName);

export const step1Frame = (doc: Y.Doc, docName = DOC_NAME): Uint8Array =>
  frame((e) => {
    encoding.writeVarUint(e, MSG.Sync);
    encoding.writeVarUint(e, SYNC.Step1);
    encoding.writeVarUint8Array(e, Y.encodeStateVector(doc));
  }, docName);

export const authFrame = (token: string, docName = DOC_NAME, authType = 0): Uint8Array =>
  frame((e) => {
    encoding.writeVarUint(e, MSG.Auth);
    encoding.writeVarUint(e, authType);
    encoding.writeVarString(e, token);
  }, docName);

/** A frame of any message type, with an optional body (#790: types Hocuspocus 4.7.1 does not handle from a client). */
export const typedFrame = (type: number, body: (e: encoding.Encoder) => void = () => undefined, docName = DOC_NAME): Uint8Array =>
  frame((e) => {
    encoding.writeVarUint(e, type);
    body(e);
  }, docName);

export const statelessFrame = (payload: string, type: number = MSG.Stateless, docName = DOC_NAME): Uint8Array =>
  frame((e) => {
    encoding.writeVarUint(e, type);
    encoding.writeVarString(e, payload);
  }, docName);

/** An awareness frame (y-protocols `encodeAwarenessUpdate` layout). `state: null` removes the client. */
export const awarenessFrame = (entries: Array<{ clientID: number; clock?: number; state: unknown; json?: string }>, docName = DOC_NAME): Uint8Array =>
  frame((e) => {
    encoding.writeVarUint(e, MSG.Awareness);
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, entries.length);
    for (const entry of entries) {
      encoding.writeVarUint(inner, entry.clientID);
      encoding.writeVarUint(inner, entry.clock ?? 1);
      encoding.writeVarString(inner, entry.json ?? JSON.stringify(entry.state)); // `json`: the state's raw text
    }
    encoding.writeVarUint8Array(e, encoding.toUint8Array(inner));
  }, docName);

/** The type and (for Close) reason of a frame the server sent. */
export function readServerFrame(data: Uint8Array): { type: number; reason?: string } {
  const d = decoding.createDecoder(new Uint8Array(data));
  decoding.readVarString(d);
  const type = decoding.readVarUint(d);
  return type === MSG.Close ? { type, reason: decoding.readVarString(d) } : { type };
}

/** A remote client: a replica of `base` with its own clientID, whose edits are sent as the diff against `base`. */
export class RemoteClient {
  readonly doc = new Y.Doc();
  constructor(base: Y.Doc, clientID?: number) {
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(base));
    // Set AFTER the load: Yjs regenerates a client id that a remote transaction touched, so setting it first would
    // silently drop an impersonation (the B4 specs write at another client's next clock on purpose).
    if (clientID !== undefined) this.doc.clientID = clientID;
  }
  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment('default');
  }
  /** Edit and return the update a client would send: everything `against` lacks. */
  edit(against: Y.Doc, change: (fragment: Y.XmlFragment, doc: Y.Doc) => void): Uint8Array {
    this.doc.transact(() => change(this.fragment, this.doc));
    return Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(against));
  }
  sync(from: Y.Doc): void {
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(from, Y.encodeStateVector(this.doc)));
  }
}

/** The JSON the server stores (`fromYdoc`), deep-copied. */
export const contentOf = (doc: Y.Doc): unknown => structuredClone(TiptapTransformer.fromYdoc(doc, 'default'));

/**
 * Render `doc` the way every browser does on open (y-tiptap `initProseMirrorDoc` over the editor schema), on a COPY.
 * Returns whether y-tiptap deleted anything from the shared document (its delete-on-error, which then syncs to every
 * peer) and whether the render itself threw. The control arm of every attack spec reads this.
 */
export function renderLikeABrowser(doc: Y.Doc): { deleted: boolean; threw: boolean; text: string } {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(copy);
  let deletes = 0;
  copy.on('update', (u: Uint8Array) => {
    deletes += Y.decodeUpdate(u).ds.clients.size;
  });
  let threw = false;
  let text = '';
  try {
    text = initProseMirrorDoc(copy.getXmlFragment('default'), serverSchema()).doc.textContent;
  } catch {
    threw = true;
  }
  const grew = !equalBytes(before, Y.encodeStateVector(copy));
  copy.destroy();
  return { deleted: deletes > 0 || grew, threw, text };
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Replace a JSON-string payload inside a V1 update (a ContentFormat value is written as `varString(JSON)`), so a spec
 * can hand-encode a value Yjs's own encoder would overflow the stack on.
 */
export function spliceVarString(update: Uint8Array, placeholder: string, replacement: string): Uint8Array {
  const enc = new TextEncoder();
  const old = encoding.createEncoder();
  encoding.writeVarString(old, placeholder);
  const needle = encoding.toUint8Array(old);
  for (let i = 0; i + needle.length <= update.length; i++) {
    if (needle.every((b, j) => update[i + j] === b)) {
      const next = encoding.createEncoder();
      encoding.writeVarString(next, replacement);
      const out = new Uint8Array(update.length - needle.length + encoding.length(next));
      out.set(update.subarray(0, i), 0);
      out.set(encoding.toUint8Array(next), i);
      out.set(update.subarray(i + needle.length), i + encoding.length(next));
      return out;
    }
  }
  throw new Error(`placeholder ${placeholder} not found (${enc.encode(placeholder).length} bytes)`);
}

/** A nested JSON object `depth` levels deep, as a string (JSON.parse is iterative, JSON.stringify is not). */
export const deepJson = (depth: number): string => '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);

/**
 * A fake `ws` socket for an in-process Hocuspocus `handleConnection`. Hocuspocus 4.x listens to no socket events: its
 * integration drives the returned `ClientConnection`, so `connect` wires it the way the gateway's standalone path does.
 */
export class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | null = null;
  binaryType = 'nodebuffer';
  /** ws's bytes queued but not yet written (#790: the outbound bounds read it); the specs move it by hand. */
  bufferedAmount = 0;
  terminated = false;
  send(message: Uint8Array, cb?: (err?: Error) => void): void {
    this.sent.push(new Uint8Array(message));
    cb?.();
  }
  ping(): void {}
  /** ws's `terminate()`: the socket closes with 1006 and no close frame. */
  terminate(): void {
    this.terminated = true;
    this.close(1006, '');
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason ?? ''));
  }
  /** Hand this socket to Hocuspocus as the gateway does (collaboration.gateway.ts, the standalone path). */
  connect(hp: Pick<Hocuspocus, 'handleConnection'>, request: Request = new Request('http://localhost/')): ReturnType<Hocuspocus['handleConnection']> {
    const clientConnection = hp.handleConnection(this as never, request);
    this.on('message', (data: Buffer) => clientConnection.handleMessage(new Uint8Array(data)));
    this.on('close', (code: number, reason: Buffer) => clientConnection.handleClose({ code, reason: reason.toString() }));
    return clientConnection;
  }
  /** Deliver frames as one TCP chunk would: synchronously, in order. */
  deliver(...frames: Uint8Array[]): void {
    for (const f of frames) this.emit('message', Buffer.from(f));
  }
  closeReasons(): string[] {
    return this.sent.map(readServerFrame).filter((f) => f.type === MSG.Close).map((f) => f.reason!);
  }
}

const text = (t: string, marks?: unknown[]) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });

/**
 * A valid document holding EVERY node and mark of the server schema (schema-names.spec.ts pins the coverage), with
 * the attribute values the editor writes.
 */
export const ALL_NODES_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Title', [{ type: 'bold' }])] },
    para(
      text('plain '),
      text('bold', [{ type: 'bold' }]),
      text('italic', [{ type: 'italic' }]),
      text('strike', [{ type: 'strike' }]),
      text('under', [{ type: 'underline' }]),
      text('code', [{ type: 'code' }]),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      text('sup', [{ type: 'superscript' }]),
      text('sub', [{ type: 'subscript' }]),
      text('hl', [{ type: 'highlight', attrs: { color: '#ffd43b', colorName: 'yellow' } }]),
      text('styled', [{ type: 'textStyle', attrs: { color: '#1971c2', fontSize: null, fontFamily: null } }]),
      text('commented', [{ type: 'comment', attrs: { commentId: 'c1', resolved: false } }]),
      { type: 'mention', attrs: { id: 'm1', label: 'Ada', entityType: 'user', entityId: 'u1' } },
      text(' '),
      { type: 'mathInline', attrs: { text: 'x^2' } },
      { type: 'status', attrs: { text: 'Done', color: 'green' } },
      { type: 'hardBreak' },
      text('end'),
    ),
    { type: 'codeBlock', attrs: { language: 'js' }, content: [text('const x = 1;')] },
    { type: 'blockquote', content: [para(text('quote'))] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [para(text('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('nested'))] }] }],
        },
      ],
    },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [para(text('first'))] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(text('task'))] }] },
    { type: 'horizontalRule' },
    { type: 'mathBlock', attrs: { text: '\\int x' } },
    {
      type: 'details',
      attrs: { open: true },
      content: [
        { type: 'detailsSummary', content: [text('Summary')] },
        { type: 'detailsContent', content: [para(text('hidden'))] },
      ],
    },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('H1'))] }, { type: 'tableHeader', content: [para(text('H2'))] }] },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: { backgroundColor: '#fff', backgroundColorName: 'white' }, content: [para(text('c1'))] },
            { type: 'tableCell', content: [para(text('c2'))] },
          ],
        },
      ],
    },
    { type: 'youtube', attrs: { src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    { type: 'image', attrs: { src: '/api/files/a1/image.png', alt: 'alt', attachmentId: 'a1' } },
    { type: 'video', attrs: { src: '/api/files/a2/video.mp4', attachmentId: 'a2' } },
    { type: 'audio', attrs: { src: '/api/files/a3/audio.mp3', attachmentId: 'a3' } },
    { type: 'pdf', attrs: { src: '/api/files/a4/doc.pdf', name: 'doc.pdf', attachmentId: 'a4' } },
    { type: 'pageBreak' },
    { type: 'callout', attrs: { type: 'info', icon: 'bulb' }, content: [para(text('callout'))] },
    { type: 'attachment', attrs: { url: '/api/files/a5/file.zip', name: 'file.zip', mime: 'application/zip', attachmentId: 'a5' } },
    { type: 'drawio', attrs: { src: '/api/files/a6/d.drawio.svg', attachmentId: 'a6' } },
    { type: 'excalidraw', attrs: { src: '/api/files/a7/e.excalidraw.svg', attachmentId: 'a7' } },
    { type: 'embed', attrs: { src: 'https://example.com/embed', provider: 'iframe' } },
    { type: 'subpages' },
    { type: 'columns', content: [{ type: 'column', content: [para(text('left'))] }, { type: 'column', content: [para(text('right'))] }] },
    { type: 'transclusionSource', attrs: { id: 't1' }, content: [para(text('shared'))] },
    { type: 'transclusionReference', attrs: { sourcePageId: 'p2', transclusionId: 't2' } },
    { type: 'base', attrs: { pageId: 'p3' } },
    para(text('last')),
  ],
};
