/**
 * CCC collab integration — NOT upstream Docmost code (#816, ADR 0036).
 *
 * Helpers for the conflict-scan specs: a raw Yjs V1 update writer (the frames an attacker hand-encodes, which no Yjs
 * API produces), the attack shapes, and the meter's unguarded step count (the control arms). NOT a jest suite and not
 * built (`.testkit.ts`, see tsconfig.build.json).
 */
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { ConflictScan, installConflictScanMeter } from './conflict-scan';

type YModule = typeof Y;
export type RawId = [client: number, clock: number];
/** One struct: `parent` (a root name or an element's id) is written only when it has neither origin nor right. */
export type RawStruct = { origin: RawId | null; right: RawId | null; parent?: string | RawId; sub?: string | null; content: Y.ContentString | Y.ContentAny | Y.ContentDeleted | Y.ContentType };
export type RawClient = { client: number; clock: number; structs: RawStruct[] };
export type RawDeletes = Array<{ client: number; ranges: Array<[clock: number, len: number]> }>;

/** A V1 update written field by field, in the given order (Yjs's own encoder sorts and merges; this does neither). */
export function rawUpdate(clients: RawClient[], ds: RawDeletes = [], YY: YModule = Y): Uint8Array {
  const enc = new YY.UpdateEncoderV1() as any;
  encoding.writeVarUint(enc.restEncoder, clients.length);
  for (const { client, clock, structs } of clients) {
    encoding.writeVarUint(enc.restEncoder, structs.length);
    enc.writeClient(client);
    encoding.writeVarUint(enc.restEncoder, clock);
    for (const s of structs) {
      const c = s.content as any;
      const sub = s.sub ?? null;
      enc.writeInfo((c.getRef() & 31) | (s.origin ? 128 : 0) | (s.right ? 64 : 0) | (sub !== null ? 32 : 0));
      if (s.origin) enc.writeLeftID(YY.createID(s.origin[0], s.origin[1]));
      if (s.right) enc.writeRightID(YY.createID(s.right[0], s.right[1]));
      if (!s.origin && !s.right) {
        if (typeof s.parent === 'string') {
          enc.writeParentInfo(true);
          enc.writeString(s.parent);
        } else {
          enc.writeParentInfo(false);
          enc.writeLeftID(YY.createID(s.parent![0], s.parent![1]));
        }
        if (sub !== null) enc.writeString(sub);
      }
      c.write(enc, 0);
    }
  }
  encoding.writeVarUint(enc.restEncoder, ds.length);
  for (const { client, ranges } of ds) {
    enc.resetDsCurVal();
    encoding.writeVarUint(enc.restEncoder, client);
    encoding.writeVarUint(enc.restEncoder, ranges.length);
    for (const [clock, len] of ranges) {
      enc.writeDsClock(clock);
      enc.writeDsLen(len);
    }
  }
  return enc.toUint8Array();
}

/** A page as the editor stores it: `default` > paragraph > XmlText(`text`), all by client 1. */
export function basePage(text = 'hello world', YY: YModule = Y) {
  const doc = new YY.Doc();
  doc.clientID = 1;
  const p = new YY.XmlElement('paragraph');
  const t = new YY.XmlText();
  doc.transact(() => {
    doc.getXmlFragment('default').insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, text);
  });
  const first = (t as any)._start.id.clock as number;
  return { doc, p, t, first, paragraphId: [p._item!.id.client, p._item!.id.clock] as RawId };
}

const chars = (origin: RawId | null, right: RawId | null, s = 'x', YY: YModule = Y): RawStruct => ({ origin, right, content: new YY.ContentString(s) });

/** A copy of `doc`'s state in a fresh doc. */
export function copyOf(doc: Y.Doc, YY: YModule = Y): Y.Doc {
  const copy = new YY.Doc();
  YY.applyUpdate(copy, YY.encodeStateAsUpdate(doc));
  return copy;
}

/** A shape: the server's document before the attack, the attack frame, and the clock of the page's first character. */
export type Shape = { base: Y.Doc; frame: Uint8Array; first: number };

/**
 * (a) The #816 shape: siblings at one origin, one struct per client id, ids rising across frames. The base holds
 * `prior` siblings (clients `from`..), the frame `n` more with higher ids. Each new item walks every sibling.
 */
export function siblingsShape(prior: number, n: number, from = 100_000): Shape {
  const b = basePage();
  const O: RawId = [1, b.first + 4];
  const R: RawId = [1, b.first + 5];
  const seed: RawClient[] = [];
  for (let i = 0; i < prior; i++) seed.push({ client: from + i, clock: 0, structs: [chars(O, R)] });
  if (prior) Y.applyUpdate(b.doc, rawUpdate(seed)); // Yjs integrates the highest id first: cheap to build
  return { base: b.doc, frame: siblingsFrame(from + prior, n, b.first), first: b.first };
}
/**
 * The next frame of the #816 shape: `n` new ids from `firstClient` on, each one character between the 5th and 6th of
 * the text `author` wrote from clock `first`.
 */
export function siblingsFrame(firstClient: number, n: number, first: number, author = 1): Uint8Array {
  const clients: RawClient[] = [];
  for (let i = 0; i < n; i++) clients.push({ client: firstClient + i, clock: 0, structs: [chars([author, first + 4], [author, first + 5])] });
  return rawUpdate(clients);
}

/** (b) Two client ids: client 2 holds `n` siblings at one origin, client 3 sends `m` more in one frame: n·m. */
export function twoClientsShape(n: number, m = n): Shape {
  const b = basePage();
  const O: RawId = [1, b.first + 4];
  const R: RawId = [1, b.first + 5];
  Y.applyUpdate(b.doc, rawUpdate([{ client: 2, clock: 0, structs: Array.from({ length: n }, () => chars(O, R)) }]));
  return { base: b.doc, frame: rawUpdate([{ client: 3, clock: 0, structs: Array.from({ length: m }, () => chars(O, R)) }]), first: b.first };
}

/** A run of `n` structs after the 5th character, alternating clients 10 and 11 so it never merges. */
function runAfter(b: ReturnType<typeof basePage>, n: number): RawId[] {
  const p: RawStruct[] = [];
  const q: RawStruct[] = [];
  const ids: RawId[] = [];
  let prev: RawId = [1, b.first + 4];
  for (let i = 0; i < n; i++) {
    const s = chars(prev, [1, b.first + 5], 'r');
    if (i % 2 === 0) {
      p.push(s);
      prev = [10, p.length - 1];
    } else {
      q.push(s);
      prev = [11, q.length - 1];
    }
    ids.push(prev);
  }
  Y.applyUpdate(b.doc, rawUpdate([{ client: 11, clock: 0, structs: q }, { client: 10, clock: 0, structs: p }]));
  return ids;
}

/** (c) One client id, `n` items at one origin with distinct rightOrigins along an `n`-struct run, in ONE frame: n². */
export function distinctRightShape(n: number): Shape {
  const b = basePage();
  const run = runAfter(b, n);
  const frame = rawUpdate([{ client: 50, clock: 0, structs: run.map((r) => chars([1, b.first + 4], r)) }]);
  return { base: b.doc, frame, first: b.first };
}

/** (d) A rightOrigin LEFT of the origin: every item walks the whole `tail` after its origin, then breaks: tail·m. */
export function rightLeftOfOriginShape(tail: number, m = tail): Shape {
  const b = basePage();
  runAfter(b, tail);
  const frame = rawUpdate([{ client: 50, clock: 0, structs: Array.from({ length: m }, () => chars([10, 0], [1, b.first])) }]);
  return { base: b.doc, frame, first: b.first };
}

/**
 * (e) A keyed history: the paragraph's `textAlign` was set `history` times (two alternating clients, never merged); the
 * frame sets it `m` times with no origin, so each item walks the whole history (the pre-walk, then the loop).
 */
export function keyedHistoryShape(history: number, m: number, client = 60): Shape {
  const b = basePage();
  const p: RawStruct[] = [];
  const q: RawStruct[] = [];
  let prev: RawId | null = null;
  for (let i = 0; i < history; i++) {
    const s: RawStruct = { origin: prev, right: null, parent: b.paragraphId, sub: 'textAlign', content: new Y.ContentAny([i % 2 ? 'left' : 'right']) };
    if (i % 2 === 0) {
      p.push(s);
      prev = [20, p.length - 1];
    } else {
      q.push(s);
      prev = [21, q.length - 1];
    }
  }
  Y.applyUpdate(b.doc, rawUpdate([{ client: 21, clock: 0, structs: q }, { client: 20, clock: 0, structs: p }]));
  const frame = rawUpdate([
    { client, clock: 0, structs: Array.from({ length: m }, () => ({ origin: null, right: null, parent: b.paragraphId, sub: 'textAlign', content: new Y.ContentAny(['center']) })) },
  ]);
  return { base: b.doc, frame, first: b.first };
}

/** The steps the frame walks on a copy of `base`, with no cap (the control arm: a count, never a wall-clock stall). */
export function unguardedSteps(base: Y.Doc, frame: Uint8Array): number {
  const meter = installConflictScanMeter(Y);
  const copy = copyOf(base);
  const scan = new ConflictScan(copy, false, Infinity);
  meter.metered(scan, () => Y.applyUpdate(copy, frame));
  return scan.steps;
}
