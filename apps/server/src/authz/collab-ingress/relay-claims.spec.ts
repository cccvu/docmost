import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { serverSchema } from '../page-write/prelim-content';
import { awarenessFrame, DOC_NAME, RemoteClient, renderLikeABrowser, SYNC, syncFrame } from './collab-ingress.testkit';
import { blocksOf, encodeStructs, type StructBlock } from './conflict-scan.testkit';
import { CLAIM_TTL_MS } from './limits';
import { ClaimLedger, compareRelay, RelayClaims, strictEqual, verifyAttested, type DecodedFrame } from './relay-claims';
import { COLLAB_REFUSAL_CODE, CollabUpdateGuard, UNRESOLVED_REASON, type CollabGuardMode } from './update-guard';

/**
 * #842 (ADR 0036 §4): owner claims. After a crash lost unsaved edits, co-editors whose Step2s each carry another's
 * awareness-only id blocked each other for good. Now an owner's frame refused `unresolved` (`unproven-owner`) leaves a
 * claim (its own structs), and a peer's relay at that owner's id lands only where it equals the claim, piece by piece
 * (relay-claims.ts R0–R6). Every forgery below must answer `unresolved` with live byte-identical, and say why in the
 * refusal line (`claim`: the anti-vacuity: a comparison really ran and failed, or really had nothing to compare with);
 * every positive lands both co-editors' texts.
 *
 * Driven like relay-binding.spec.ts: `send` stands in for Hocuspocus (the guard, then the apply), `meta` for the
 * awareness clocks, and `open` for the document's connections (what the guard reads for a narrowed owner).
 */
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const SEED = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }] };
const B_ID = 1001; // the owner whose claim is recorded first
const A_ID = 2002; // the relayer (and owner of its own lost tail)
const M_ID = 3003; // another relayer
const B_TAB = 4004;

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };
type Ctx = { life1: Y.Doc; a: RemoteClient; b: RemoteClient; m: RemoteClient | null };
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const firstText = (d: Y.Doc) => textOf(d.getXmlFragment('default').get(0) as Y.XmlElement);
const sameBytes = (x: Uint8Array, y: Uint8Array) => Buffer.from(x).equals(Buffer.from(y));

/** A local edit (origin 'local', what an UndoManager tracks here), sent to life 1 and pulled by `to`. */
function relayed(ctx: Ctx, from: RemoteClient, edit: (d: Y.Doc) => void, ...to: Array<RemoteClient | null>): void {
  const sv = Y.encodeStateVector(ctx.life1);
  from.doc.transact(() => edit(from.doc), 'local');
  Y.applyUpdate(ctx.life1, Y.encodeStateAsUpdate(from.doc, sv));
  for (const peer of to) peer?.sync(ctx.life1);
}
const typeAt0 = (text: string) => (d: Y.Doc) => firstText(d).insert(0, text);

/**
 * Lifetime 1: B and A typed a stored prefix; then (`script`, default: B types `B-lost `, relayed to A and M; A types
 * `A-lost `, relayed to B) edits inside the store debounce, lost in the crash. M joined after B's lost edit.
 */
function lifetime1(script?: (ctx: Ctx) => void, opts: { bUndo?: boolean; aUndo?: boolean } = {}) {
  const life1 = new Y.Doc();
  Y.applyUpdate(life1, Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default')));
  const b = new RemoteClient(life1, B_ID);
  const a = new RemoteClient(life1, A_ID);
  const ctx: Ctx = { life1, a, b, m: null };
  if (opts.bUndo) new Y.UndoManager(b.fragment, { trackedOrigins: new Set(['local']) });
  if (opts.aUndo) new Y.UndoManager(a.fragment, { trackedOrigins: new Set(['local']) });
  relayed(ctx, b, typeAt0('B-stored '), a);
  relayed(ctx, a, typeAt0('A-stored '), b);
  const stored = Y.encodeStateAsUpdate(life1);
  (
    script ??
    ((c) => {
      relayed(c, c.b, typeAt0('B-lost '), c.a);
      c.m = new RemoteClient(c.life1, M_ID);
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    })
  )(ctx);
  return { stored, ...ctx };
}

/** Lifetime 2 under a fresh guard. */
function lifetime(stored: Uint8Array, opts: { mode?: CollabGuardMode; now?: () => number; ledger?: ClaimLedger } = {}) {
  const open: Conn[] = [];
  const live = new Y.Doc() as Y.Doc & { name: string; awareness: { meta: Map<number, { clock: number }> }; getConnections: () => Conn[] };
  live.name = DOC_NAME;
  Y.applyUpdate(live, stored);
  live.awareness = { meta: new Map() };
  live.getConnections = () => open;
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({ mode: opts.mode ?? 'enforce', logger: { warn: (m: string) => logs.push(m) }, now: opts.now, claimLedger: opts.ledger });
  const conn = (id: string, readOnly = false): Conn => {
    const c = { readOnly, webSocket: { close: jest.fn() }, context: { user: { id } } };
    open.push(c);
    return c;
  };
  const deliver = (c: Conn, frame: Uint8Array, apply?: Uint8Array): string => {
    try {
      guard.check({ connection: c, document: live, update: frame, context: c.context });
    } catch (err: any) {
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      open.splice(open.indexOf(c), 1); // Hocuspocus removes a refused session's connection
      return err.reason;
    }
    if (apply) Y.applyUpdate(live, apply, c);
    return 'applied';
  };
  const announce = (c: Conn, clientID: number, clock = 1): string => {
    const out = deliver(c, awarenessFrame([{ clientID, clock, state: { user: { name: c.context.user.id } } }]));
    if (out === 'applied' && (live.awareness.meta.get(clientID)?.clock ?? -1) < clock) live.awareness.meta.set(clientID, { clock });
    return out;
  };
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Step2) => deliver(c, syncFrame(update, subtype), update);
  const step2 = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc, Y.encodeStateVector(live));
  const refusals = () => logs.filter((l) => l.startsWith('COLLAB_UPDATE_REFUSED')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  const lastClaim = () => refusals().slice(-1)[0]?.claim;
  const attestedLines = () => logs.filter((l) => l.startsWith('COLLAB_RELAY_ATTESTED')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  const state = () => Y.encodeStateAsUpdate(live);
  return { live, guard, logs, open, conn, deliver, announce, send, step2, refusals, lastClaim, attestedLines, state };
}
type Life = ReturnType<typeof lifetime>;

/**
 * Both announce; B's Step2 (carrying A's unproven id) is refused `unresolved` and leaves B's claim; A's connection is
 * open and announced. `bFrame` replaces B's Step2 (a re-encoding of it).
 */
function claimed(l1: ReturnType<typeof lifetime1>, opts: Parameters<typeof lifetime>[1] & { bFrame?: (step2: Uint8Array) => Uint8Array } = {}) {
  const s = lifetime(l1.stored, opts);
  const bConn = s.conn('B');
  const aConn = s.conn('A');
  expect(s.announce(bConn, B_ID)).toBe('applied');
  expect(s.announce(aConn, A_ID)).toBe('applied');
  const bStep2 = s.step2(l1.b.doc);
  expect(s.send(bConn, opts.bFrame ? opts.bFrame(bStep2) : bStep2)).toBe(UNRESOLVED_REASON);
  expect(s.refusals().slice(-1)[0]).toMatchObject({ rule: 'foreign-client', stage: 'unproven-owner', userId: 'B' });
  return { s, bConn, aConn, bStep2 };
}

/** A's Step2, its B_ID block replaced by `edit`'s result (ds edits too). */
function rewritten(s: Life, a: RemoteClient, edit: (blocks: StructBlock[], ds: Array<{ client: number; ranges: Array<[number, number]> }>) => void): Uint8Array {
  const { blocks, ds } = blocksOf(s.step2(a.doc));
  edit(blocks, ds);
  return encodeStructs(blocks, ds);
}
const blockOf = (blocks: StructBlock[], client: number) => blocks.find((b) => b.client === client)!;
const itemAt = (blocks: StructBlock[], client: number, i = 0) => blockOf(blocks, client).structs[i] as Y.Item;
const cloneItem = (it: Y.Item, patch: Partial<{ origin: Y.ID | null; rightOrigin: Y.ID | null; parent: unknown; parentSub: string | null; content: Y.Item["content"] }>) =>
  new Y.Item(
    it.id,
    null,
    'origin' in patch ? patch.origin! : it.origin,
    null,
    'rightOrigin' in patch ? patch.rightOrigin! : it.rightOrigin,
    ('parent' in patch ? patch.parent : it.parent) as any,
    'parentSub' in patch ? patch.parentSub! : it.parentSub,
    patch.content ?? it.content,
  );
/** Split decoded item `it` at offset k into two structs, as an encoder that held it split writes it. */
const splitItem = (it: Y.Item, k: number): Y.Item[] => {
  const str = (it.content as Y.ContentString).str;
  return [
    cloneItem(it, { content: new Y.ContentString(str.slice(0, k)) }),
    new Y.Item(Y.createID(it.id.client, it.id.clock + k), null, Y.createID(it.id.client, it.id.clock + k - 1), null, it.rightOrigin, null, null, new Y.ContentString(str.slice(k))),
  ];
};

/** Every forgery: unresolved, live byte-identical, and the claim word given. */
function expectUnresolved(s: Life, c: Conn, frame: Uint8Array, claim: string): void {
  const before = s.state();
  expect(s.send(c, frame)).toBe(UNRESOLVED_REASON);
  expect(sameBytes(s.state(), before)).toBe(true);
  expect(s.refusals().slice(-1)[0]).toMatchObject({ rule: 'foreign-client', stage: 'unproven-owner', claim });
  expect(s.attestedLines()).toEqual([]);
}

describe('#842 positives: a relay equal to its owner\'s claim lands, then the owner\'s retry', () => {
  it('exact: A\'s Step2 (B\'s lost tail and its own) lands on B\'s claim; B\'s retry lands; both texts', () => {
    const l1 = lifetime1();
    const { s } = claimed(l1);
    const aConn = s.open.find((c) => c.context.user.id === 'A')!;
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
    expect(s.attestedLines()).toEqual([expect.objectContaining({ userId: 'A', ids: 1, clocks: 'B-lost '.length })]);
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe('applied');
    expect(renderLikeABrowser(s.live)).toMatchObject({ deleted: false, threw: false, text: 'A-lost B-lost A-stored B-stored base' });
  });

  it('a prefix: A was relayed only B\'s first lost edit; the claim holds both', () => {
    const l1 = lifetime1((c) => {
      relayed(c, c.b, typeAt0('B-lost '), c.a);
      relayed(c, c.b, typeAt0('B-more ')); // never reached A
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    });
    const { s, aConn } = claimed(l1);
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('B-more A-lost B-lost A-stored B-stored base'); // B-more and A-lost: concurrent
  });

  it.each([
    ['the relay split where the claim is one struct', false, true],
    ['the claim split where the relay is one struct', true, false],
  ])('%s: pieces compare run-length', (_n, claimSplit, relaySplit) => {
    const l1 = lifetime1();
    const split = (u: Uint8Array) => {
      const { blocks, ds } = blocksOf(u);
      const block = blockOf(blocks, B_ID);
      block.structs = block.structs.flatMap((st) => (st instanceof Y.Item && st.content instanceof Y.ContentString && st.length > 3 ? splitItem(st, 3) : [st]));
      return encodeStructs(blocks, ds);
    };
    const { s, aConn } = claimed(l1, claimSplit ? { bFrame: split } : {});
    const relay = s.step2(l1.a.doc);
    expect(s.send(aConn, relaySplit ? split(relay) : relay)).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('A-lost B-lost A-stored B-stored base');
  });

  it('UndoManager keep, owner side: B deleted its lost text (kept, plus a delete set); A\'s gc\'d copy relays ContentDeleted (R4)', () => {
    const l1 = lifetime1(
      (c) => {
        relayed(c, c.b, typeAt0('B-lost '), c.a);
        relayed(c, c.b, (d) => firstText(d).delete(0, 7), c.a);
        relayed(c, c.a, typeAt0('A-lost '), c.b);
      },
      { bUndo: true },
    );
    const claim = Y.decodeUpdate(Y.encodeStateAsUpdate(l1.b.doc, Y.encodeStateVector(docOf(l1.stored))));
    expect(claim.structs.some((st) => st.id.client === B_ID && st instanceof Y.Item && st.content instanceof Y.ContentString)).toBe(true); // kept
    expect(claim.ds.clients.has(B_ID)).toBe(true);
    const { s, aConn } = claimed(l1);
    const relay = Y.decodeUpdate(s.step2(l1.a.doc));
    expect(relay.structs.some((st) => st.id.client === B_ID && st instanceof Y.Item && st.content instanceof Y.ContentDeleted)).toBe(true);
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('A-lost A-stored B-stored base');
  });

  it('UndoManager keep, relayer side: A deleted B\'s lost text (kept, plus its delete set) that B still holds live (R4)', () => {
    const l1 = lifetime1(
      (c) => {
        relayed(c, c.b, typeAt0('B-lost '), c.a);
        relayed(c, c.a, (d) => firstText(d).delete(0, 7)); // never reached B
        relayed(c, c.a, typeAt0('A-lost '), c.b);
      },
      { aUndo: true },
    );
    const { s, aConn } = claimed(l1);
    const relay = Y.decodeUpdate(s.step2(l1.a.doc));
    expect(relay.structs.some((st) => st.id.client === B_ID && st instanceof Y.Item && st.content instanceof Y.ContentString)).toBe(true); // kept
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('A-lost A-stored B-stored base');
  });

  it('a relay GC under a deleted parent: B\'s lost paragraph, deleted by A (its children GC in A\'s copy), lands with evidence (R6)', () => {
    const para = (d: Y.Doc) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, 'B-para');
      d.getXmlFragment('default').insert(1, [p]);
    };
    const l1 = lifetime1((c) => {
      relayed(c, c.b, para, c.a);
      relayed(c, c.a, (d) => d.getXmlFragment('default').delete(1, 1)); // never reached B
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    });
    const { s, aConn } = claimed(l1);
    const relay = Y.decodeUpdate(s.step2(l1.a.doc));
    expect(relay.structs.some((st) => st.id.client === B_ID && st instanceof Y.GC)).toBe(true); // precondition
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe('applied');
    expect(renderLikeABrowser(s.live)).toMatchObject({ deleted: false, threw: false, text: 'A-lost A-stored B-stored base' });
  });

  it('the owner absent (its refused session is gone, no retry yet) within the TTL: its claim still attests', () => {
    let t = 1_000_000;
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1, { now: () => t });
    expect(s.open.some((c) => c.context.user.id === 'B')).toBe(false);
    t += CLAIM_TTL_MS;
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
  });
});

describe('#842 forgeries at the owner\'s id answer unresolved, live byte-identical', () => {
  /** A ContentString of the same length with one character changed. */
  const oneChar = (it: Y.Item) => {
    const str = (it.content as Y.ContentString).str;
    return new Y.ContentString(str.slice(0, 2) + (str[2] === 'z' ? 'y' : 'z') + str.slice(3));
  };
  const someStoredId = (s: Life): Y.ID => (firstText(s.live) as any)._start.id; // A's stored text, in the same list

  it.each<[string, (it: Y.Item, s: Life) => Y.Item]>([
    ['content (one character)', (it) => cloneItem(it, { content: oneChar(it) })],
    ['origin', (it, s) => cloneItem(it, { origin: someStoredId(s) })],
    ['rightOrigin', (it, s) => cloneItem(it, { rightOrigin: Y.createID(someStoredId(s).client, someStoredId(s).clock + 1) })],
    ['class (Any for String)', (it) => cloneItem(it, { content: new Y.ContentAny(Array.from((it.content as Y.ContentString).str)) })],
  ])('%s', (_name, forge) => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    const control = s.step2(l1.a.doc);
    const forged = rewritten(s, l1.a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      block.structs[0] = forge(block.structs[0] as Y.Item, s);
    });
    expect(sameBytes(forged, control)).toBe(false);
    expectUnresolved(s, aConn, forged, 'mismatch');
  });

  describe('parent and parentSub (compared where both origins are null)', () => {
    const para = (d: Y.Doc) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, 'B-para');
      d.getXmlFragment('default').insert(1, [p]);
    };
    const script = (c: Ctx) => {
      relayed(c, c.b, para, c.a);
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    };
    it.each<[string, (it: Y.Item, s: Life) => Y.Item]>([
      ['parent', (it, s) => cloneItem(it, { parent: (firstText(s.live) as any)._item.id })],
      ['parentSub', (it) => cloneItem(it, { parentSub: 'x' })],
    ])('%s', (_name, forge) => {
      const l1 = lifetime1(script);
      const { s, aConn } = claimed(l1);
      const forged = rewritten(s, l1.a, (blocks) => {
        const block = blockOf(blocks, B_ID);
        const i = block.structs.findIndex((st) => st instanceof Y.Item && st.content instanceof Y.ContentString);
        const it = block.structs[i] as Y.Item;
        expect(it.origin === null && it.rightOrigin === null).toBe(true); // precondition: its parent is on the wire
        block.structs[i] = forge(it, s);
      });
      expectUnresolved(s, aConn, forged, 'mismatch');
      // control: the frame unforged lands (on a fresh claim: A is burned for this one)
      const fresh = lifetime1(script);
      const c = claimed(fresh);
      expect(c.s.send(c.aConn, c.s.step2(fresh.a.doc))).toBe('applied');
    });
  });

  it.each([
    ['{__proto__: null} for {}', {}, JSON.parse('{"__proto__": null}')],
    ['-0 for 0', 0, -0],
    ['keys in another order', { a: 1, b: 2 }, { b: 2, a: 1 }],
  ])('ContentAny, a strict deep equal: %s', (_name, value, forgedValue) => {
    const l1 = lifetime1((c) => {
      relayed(c, c.b, (d) => (d.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('data', value as any), c.a);
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    });
    const { s, aConn } = claimed(l1);
    const forged = rewritten(s, l1.a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      const i = block.structs.findIndex((st) => st instanceof Y.Item && st.content instanceof Y.ContentAny);
      block.structs[i] = cloneItem(block.structs[i] as Y.Item, { content: new Y.ContentAny([forgedValue]) });
    });
    expectUnresolved(s, aConn, forged, 'mismatch');
  });

  describe('R5 for elements and marks: what a peer would plant at a co-editor\'s position', () => {
    const para = (d: Y.Doc) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, 'B-para');
      d.getXmlFragment('default').insert(1, [p]);
    };
    const bold = (d: Y.Doc) => firstText(d).format(0, 4, { bold: true }); // B marks stored text: ContentFormat at B's id
    const withA = (edit: (d: Y.Doc) => void) => (c: Ctx) => {
      relayed(c, c.b, edit, c.a);
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    };
    const nth = (block: StructBlock, pick: (it: Y.Item) => boolean) => block.structs.findIndex((st) => st instanceof Y.Item && pick(st));
    it.each<[string, (d: Y.Doc) => void, (it: Y.Item) => boolean, (it: Y.Item) => Y.Item]>([
      [
        'an element of another name (heading for paragraph)',
        para,
        (it) => it.content instanceof Y.ContentType,
        (it) => cloneItem(it, { content: new Y.ContentType(new Y.XmlElement('heading')) }),
      ],
      [
        'a mark of another key (italic for bold)',
        bold,
        (it) => it.content instanceof Y.ContentFormat && (it.content as Y.ContentFormat).value !== null,
        (it) => cloneItem(it, { content: new Y.ContentFormat('italic', (it.content as Y.ContentFormat).value) }),
      ],
      [
        'a mark of another value (a link href)',
        bold,
        (it) => it.content instanceof Y.ContentFormat && (it.content as Y.ContentFormat).value !== null,
        (it) => cloneItem(it, { content: new Y.ContentFormat((it.content as Y.ContentFormat).key, { href: 'https://forged.example' }) }),
      ],
    ])('%s', (_name, edit, pick, forge) => {
      const l1 = lifetime1(withA(edit));
      const { s, aConn } = claimed(l1);
      const forged = rewritten(s, l1.a, (blocks) => {
        const block = blockOf(blocks, B_ID);
        const i = nth(block, pick);
        expect(i).toBeGreaterThanOrEqual(0); // precondition: the struct the forgery rewrites is in the relay
        block.structs[i] = forge(block.structs[i] as Y.Item);
      });
      expect(sameBytes(forged, s.step2(l1.a.doc))).toBe(false);
      expectUnresolved(s, aConn, forged, 'mismatch');
      // control: unforged, the same relay lands (on a fresh claim: A is burned for this one)
      const fresh = lifetime1(withA(edit));
      const c = claimed(fresh);
      expect(c.s.send(c.aConn, c.s.step2(fresh.a.doc))).toBe('applied');
    });
  });

  it('clocks beyond the claim (R2): uncovered, and burned (the claim\'s extent is an answer too)', () => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    const forged = rewritten(s, l1.a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      const last = block.structs[block.structs.length - 1];
      block.structs.push(new Y.Item(Y.createID(B_ID, last.id.clock + last.length), null, Y.createID(B_ID, last.id.clock + last.length - 1), null, (last as Y.Item).rightOrigin, null, null, new Y.ContentString('X')));
    });
    expectUnresolved(s, aConn, forged, 'uncovered');
    expectUnresolved(s, s.conn('A'), s.step2(l1.a.doc), 'burned'); // right, and no longer compared
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    // recovery still converges: A's refused frames left A's own claim, so B's retry lands on it (proving B), then A's
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe('applied');
    expect(s.send(s.conn('A'), s.step2(l1.a.doc))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toContain('B-lost');
  });

  it('a repeated client block (the first exact, the second forged) is refused client-blocks before any comparison', () => {
    const l1 = lifetime1();
    const { s, aConn, bStep2 } = claimed(l1);
    const forged = rewritten(s, l1.a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      const it = block.structs[0] as Y.Item;
      blocks.push({ client: B_ID, clock: block.clock, structs: [cloneItem(it, { content: oneChar(it) })] });
    });
    const before = s.state();
    expect(s.send(aConn, forged)).toBe(REFUSED('client-blocks'));
    expect(sameBytes(s.state(), before)).toBe(true);
    // and the comparator, handed such a frame without the pre-pass, never matches it (the second block is not contiguous)
    const claim = Y.decodeUpdate(Y.diffUpdate(bStep2, Y.encodeStateVector(new Map([[A_ID, Number.MAX_SAFE_INTEGER]])))) as unknown as DecodedFrame;
    expect(compareRelay(Y.decodeUpdate(forged) as unknown as DecodedFrame, claim, B_ID, Y.getState(s.live.store, B_ID))).toBe('uncovered');
  });

  it('a straddling struct with a foreign start origin (R1): uncovered, even where its tail equals the claim', () => {
    // B's lost text continues its stored text, so the claim's first piece has origin (B, L-1): a straddle from L-1 whose
    // tail compares equal there would integrate that tail under the WIRE start origin's parent (another list)
    const l1 = lifetime1((c) => {
      relayed(c, c.b, (d) => firstText(d).insert('A-stored B-stored '.length, 'B-lost '), c.a);
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    });
    const { s, aConn } = claimed(l1);
    const L = Y.getState(s.live.store, B_ID);
    expect(L).toBeGreaterThan(0); // precondition: B's stored prefix
    const forged = rewritten(s, l1.a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      const it = block.structs[0] as Y.Item;
      expect(it.origin).toEqual(Y.createID(B_ID, L - 1)); // precondition
      const otherList: Y.ID = ((s.live.getXmlFragment('default').get(0) as Y.XmlElement) as any)._item.id; // the root list
      block.clock = L - 1;
      block.structs[0] = new Y.Item(Y.createID(B_ID, L - 1), null, otherList, null, it.rightOrigin, null, null, new Y.ContentString(' ' + (it.content as Y.ContentString).str));
      blocks.splice(0, blocks.length, block); // B's id alone
    });
    expectUnresolved(s, aConn, forged, 'uncovered');
    // decided on the relay alone (R1), before the claim is read: it says nothing about the claim, so nothing is burned
    expect(s.send(s.conn('A'), s.step2(l1.a.doc))).toBe('applied');
  });

  it('a relay GC for a claimed Item in a live parent (R6, no evidence after the apply): mismatch', () => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    const forged = rewritten(s, l1.a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      const it = block.structs[0] as Y.Item;
      block.structs[0] = new Y.GC(it.id, it.length);
    });
    expectUnresolved(s, aConn, forged, 'mismatch');
    expect(s.send(s.conn('A'), s.step2(l1.a.doc))).toBe(UNRESOLVED_REASON); // the relayer is burned for this claim
    expect(s.lastClaim()).toBe('burned');
  });

  it.each([
    ['gc\'d to ContentDeleted', false],
    ['kept with a delete set (an UndoManager)', true],
  ])('a resurrection (R5): B deleted its lost text, %s; A\'s copy still holds it live', (_n, bUndo) => {
    const l1 = lifetime1(
      (c) => {
        relayed(c, c.b, typeAt0('B-lost '), c.a);
        relayed(c, c.b, (d) => firstText(d).delete(0, 7)); // never reached A
        relayed(c, c.a, typeAt0('A-lost '), c.b);
      },
      { bUndo },
    );
    const { s, aConn } = claimed(l1);
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'mismatch');
    expect(renderLikeABrowser(s.live).text).not.toContain('B-lost');
  });

  it.each<[string, (L: number, len: number) => Array<[number, number]>]>([
    ['a zero-length range over the forged clocks', (L) => [[L, 0]]],
    ['a range only over clocks the relay does not carry', (L, len) => [[L + len, 5]]],
  ])('an R4 delete-set trick, %s: the forged content is compared (R5) and refused', (_n, ranges) => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    const L = Y.getState(s.live.store, B_ID);
    const forged = rewritten(s, l1.a, (blocks, ds) => {
      const block = blockOf(blocks, B_ID);
      const it = block.structs[0] as Y.Item;
      block.structs[0] = cloneItem(it, { content: new Y.ContentString('E'.repeat(it.length)) });
      ds.push({ client: B_ID, ranges: ranges(L, it.length) });
    });
    const before = s.state();
    expect(s.send(aConn, forged)).toBe(UNRESOLVED_REASON);
    expect(sameBytes(s.state(), before)).toBe(true);
    expect(s.lastClaim()).toBe('mismatch');
    expect(renderLikeABrowser(s.live).text).not.toContain('E');
  });
});

describe('#842 an attested relay is still judged by every rule (it falls through, never skips)', () => {
  it('a claim holding a value the rules refuse (never checked: the owner\'s frame stopped at the unproven id first) is refused', () => {
    const l1 = lifetime1((c) => {
      // a listItem whose first child is a list: every struct is valid alone, the element is not (only the shadow sees it)
      const el = (name: string, ...children: Array<Y.XmlElement | Y.XmlText>) => {
        const e = new Y.XmlElement(name);
        e.insert(0, children);
        return e;
      };
      relayed(c, c.b, (d) => d.getXmlFragment('default').insert(1, [el('bulletList', el('listItem', el('bulletList', el('listItem', el('paragraph', new Y.XmlText('x'))))))]), c.a);
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    });
    const { s, aConn } = claimed(l1);
    const before = s.state();
    const answer = s.send(aConn, s.step2(l1.a.doc));
    expect(answer).toBe(REFUSED('schema')); // a content rule, final: never applied
    expect(sameBytes(s.state(), before)).toBe(true);
    expect(s.attestedLines()).toEqual([]);
  });
});

describe('#842 what records a claim, and what keeps one usable', () => {
  it('a claim is never recorded from a non-owner: M\'s frame carrying forged structs at B\'s id seeds nothing', () => {
    const l1 = lifetime1();
    const s = lifetime(l1.stored);
    const bConn = s.conn('B');
    expect(s.announce(bConn, B_ID)).toBe('applied');
    const mConn = s.conn('M');
    expect(s.announce(mConn, M_ID)).toBe('applied');
    const forged = (() => {
      const { blocks, ds } = blocksOf(s.step2(l1.m!.doc));
      const block = blockOf(blocks, B_ID);
      const it = block.structs[0] as Y.Item;
      block.structs[0] = cloneItem(it, { content: new Y.ContentString('F'.repeat(it.length)) });
      return encodeStructs(blocks, ds);
    })();
    expect(s.send(mConn, forged)).toBe(UNRESOLVED_REASON);
    const aConn = s.conn('A');
    expect(s.announce(aConn, A_ID)).toBe('applied');
    expectUnresolved(s, aConn, forged, 'none');
  });

  it.each<[string, (s: Life, b: RemoteClient) => Uint8Array, string]>([
    [
      'a pending-dependency unresolved',
      (s, b) => {
        const other = new RemoteClient(s.live, 5555);
        firstText(other.doc).insert(0, 'x');
        const sv = Y.encodeStateVector(other.doc);
        firstText(other.doc).insert(0, 'y');
        return Y.mergeUpdates([s.step2(b.doc), Y.encodeStateAsUpdate(other.doc, sv)]);
      },
      UNRESOLVED_REASON,
    ],
    [
      'a content refusal',
      (s, b) => {
        const el = (name: string, ...children: Array<Y.XmlElement | Y.XmlText>) => {
          const e = new Y.XmlElement(name);
          e.insert(0, children);
          return e;
        };
        b.doc.transact(() => b.fragment.insert(b.fragment.length, [el('bulletList', el('listItem', el('bulletList', el('listItem', el('paragraph', new Y.XmlText('x'))))))]));
        return s.step2(b.doc);
      },
      REFUSED('schema'),
    ],
  ])('a claim is never recorded from %s', (_n, frameOf, answer) => {
    const l1 = lifetime1((c) => relayed(c, c.b, typeAt0('B-lost '), c.a)); // one-sided: B's frame carries only its own id
    const s = lifetime(l1.stored);
    const bConn = s.conn('B');
    expect(s.announce(bConn, B_ID)).toBe('applied');
    expect(s.send(bConn, frameOf(s, l1.b))).toBe(answer);
    const aConn = s.conn('A');
    expect(s.announce(aConn, A_ID)).toBe('applied');
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'none');
  });

  it('a claim covers only ids this connection announced: B\'s other tab sending B\'s old id\'s structs seeds nothing', () => {
    const l1 = lifetime1();
    const s = lifetime(l1.stored);
    expect(s.announce(s.conn('B'), B_ID)).toBe('applied'); // B's first tab binds B_ID
    const aConn = s.conn('A');
    expect(s.announce(aConn, A_ID)).toBe('applied');
    const tab = s.conn('B');
    expect(s.announce(tab, B_TAB)).toBe('applied');
    expect(s.send(tab, s.step2(l1.b.doc))).toBe(UNRESOLVED_REASON); // carries B_ID (B's) and A_ID (unproven)
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'none');
  });

  it('an owner narrowed to read-only on the document: its claim is not used', () => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    s.conn('B', true); // the revalidator narrowed B (or B reconnected read-only)
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'none');
  });

  it('another user\'s read-only connection (a viewer on the page) leaves the owner\'s claim usable', () => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    s.conn('V', true); // a reader of the page, not the owner
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied');
    expect(s.attestedLines()).toHaveLength(1);
  });

  it('past CLAIM_TTL_MS: the claim is not used', () => {
    let t = 1_000_000;
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1, { now: () => t });
    t += CLAIM_TTL_MS + 1;
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'none');
  });

  it('dropped on prove: B\'s accepted frame drops its claim, and its bytes', () => {
    const ledger = new ClaimLedger();
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1, { ledger });
    expect(ledger.bytes('B')).toBeGreaterThan(0);
    expect(s.send(aConn, s.step2(l1.a.doc))).toBe('applied'); // A's claim is not recorded: A's frame was accepted
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, typeAtFrom(s, l1.b, 'B-new '), SYNC.Update)).toBe('applied'); // new clocks: B_ID proven
    expect(ledger.bytes('B')).toBe(0);
    expect(ledger.bytes()).toBe(0);
  });

  it('past CLAIM_TTL_MS its bytes go back at the next frame on any page, without any claim activity', () => {
    let t = 1_000_000;
    const ledger = new ClaimLedger();
    const l1 = lifetime1();
    const { s } = claimed(l1, { now: () => t, ledger });
    expect(ledger.bytes('B')).toBeGreaterThan(0);
    t += CLAIM_TTL_MS + 1;
    const other = lifetime(l1.stored, { now: () => t, ledger }); // another document, same process
    const c = other.conn('C');
    expect(other.announce(c, 9009)).toBe('applied');
    expect(other.send(c, typeAtFrom(other, new RemoteClient(other.live, 9009), 'C '), SYNC.Update)).toBe('applied');
    expect(ledger.bytes('B')).toBe(0);
    expect(ledger.bytes()).toBe(0);
    expect(s.guard).toBeDefined();
  });

  it('an owner\'s next claim replaces its earlier one: the earlier bytes go back first', () => {
    const ledger = new ClaimLedger();
    const claims = new RelayClaims(ledger);
    const { b, stored } = lifetime1();
    const own = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(docOf(stored)));
    expect(claims.record('B', new Set([B_ID]), own, [B_ID], 0)).toBe('recorded');
    const one = ledger.bytes('B');
    expect(one).toBeGreaterThan(0);
    expect(claims.record('B', new Set([B_ID]), own, [B_ID], 1)).toBe('recorded');
    expect(ledger.bytes('B')).toBe(one);
    expect(ledger.bytes()).toBe(one);
  });

  it('the document\'s destroy drops every claim and its bytes', () => {
    const ledger = new ClaimLedger();
    const { s } = claimed(lifetime1(), { ledger });
    expect(ledger.bytes()).toBeGreaterThan(0);
    s.live.destroy();
    expect(ledger.bytes()).toBe(0);
  });

  it('the per-user cap: no room, nothing recorded (claim: full), the relay keeps today\'s answer', () => {
    const l1 = lifetime1();
    const ledger = new ClaimLedger(16, 1 << 20);
    const s = lifetime(l1.stored, { ledger });
    const bConn = s.conn('B');
    const aConn = s.conn('A');
    s.announce(bConn, B_ID);
    s.announce(aConn, A_ID);
    expect(s.send(bConn, s.step2(l1.b.doc))).toBe(UNRESOLVED_REASON);
    expect(s.lastClaim()).toBe('full');
    expect(ledger.bytes()).toBe(0);
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'full'); // no claim of B's to compare with; A's own found no room either
  });

  it('the process total (claims of every document): no room, nothing recorded (full), and nothing evicted', () => {
    const l1 = lifetime1();
    const probe = new ClaimLedger();
    claimed(l1, { ledger: probe });
    const one = probe.bytes();
    const ledger = new ClaimLedger(1 << 30, one + 8); // room for one claim
    const first = claimed(l1, { ledger }); // one document
    const second = claimed(l1, { ledger }); // another document in the same process
    expect(second.s.lastClaim()).toBe('full');
    expect(ledger.bytes()).toBe(one);
    expectUnresolved(second.s, second.aConn, second.s.step2(l1.a.doc), 'full'); // nothing of B's; no room for A's either
    expect(first.s.send(first.aConn, first.s.step2(l1.a.doc))).toBe('applied'); // the first claim was never evicted
  });

  it('report mode records no claims', () => {
    const ledger = new ClaimLedger();
    const l1 = lifetime1();
    const s = lifetime(l1.stored, { mode: 'report', ledger });
    const bConn = s.conn('B');
    s.announce(bConn, B_ID);
    s.announce(s.conn('A'), A_ID);
    expect(s.send(bConn, s.step2(l1.b.doc))).toBe('applied'); // report mode: logged, applied
    expect(s.refusals().slice(-1)[0]).toMatchObject({ stage: 'unproven-owner', mode: 'report' });
    expect(ledger.bytes()).toBe(0);
  });
});

describe('#842 the guess budget: one comparison per relayer per claim instance', () => {
  /** A guess at B's lost text, B's id alone (so the probe leaves no claim of A's that B's retry could land on). */
  const forge = (s: Life, a: RemoteClient, ch: string) =>
    rewritten(s, a, (blocks) => {
      const block = blockOf(blocks, B_ID);
      const it = block.structs[0] as Y.Item;
      block.structs[0] = cloneItem(it, { content: new Y.ContentString(ch.repeat(it.length)) });
      blocks.splice(0, blocks.length, block);
    });

  it('a second probe by the same relayer gets unresolved without a comparison, even when right; another relayer gets its own', () => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    expectUnresolved(s, aConn, forge(s, l1.a, 'G'), 'mismatch');
    const again = s.conn('A');
    expect(s.announce(again, A_ID, 2)).toBe('applied');
    expectUnresolved(s, again, s.step2(l1.a.doc), 'burned'); // right, and still not compared
    const m = s.conn('M');
    expect(s.announce(m, M_ID)).toBe('applied');
    const { blocks, ds } = blocksOf(s.step2(l1.m!.doc));
    expect(s.send(m, encodeStructs(blocks.filter((b) => b.client === B_ID), ds))).toBe('applied'); // M's one comparison
  });

  it('a new claim instance (the owner\'s next refusal) resets the budget', () => {
    const l1 = lifetime1();
    const { s, aConn } = claimed(l1);
    expectUnresolved(s, aConn, forge(s, l1.a, 'G'), 'mismatch');
    const bRetry = s.conn('B');
    expect(s.announce(bRetry, B_ID, 2)).toBe('applied');
    expect(s.send(bRetry, s.step2(l1.b.doc))).toBe(UNRESOLVED_REASON); // A's id is still unproven: a new claim
    const again = s.conn('A');
    expect(s.announce(again, A_ID, 2)).toBe('applied');
    expect(s.send(again, s.step2(l1.a.doc))).toBe('applied');
  });

  it('probes that delete their own guess (R4) land the same whatever the guess: positions only, no content revealed, nothing burned', () => {
    const answers = ['B', 'Q'].map((ch) => {
      const l1 = lifetime1();
      const { s, aConn } = claimed(l1);
      const L = Y.getState(s.live.store, B_ID);
      const probe = rewritten(s, l1.a, (blocks, ds) => {
        const block = blockOf(blocks, B_ID);
        const it = block.structs[0] as Y.Item;
        if (ch !== 'B') block.structs[0] = cloneItem(it, { content: new Y.ContentString(ch.repeat(it.length)) });
        ds.push({ client: B_ID, ranges: [[L, it.length]] });
      });
      const answer = s.send(aConn, probe);
      return { answer, text: renderLikeABrowser(s.live).text, refusals: s.refusals().length };
    });
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual({ answer: 'applied', text: 'A-lost A-stored B-stored base', refusals: 1 });
  });
});

describe('#842 the guess budget: every answer the claim decided burns, whatever rule refuses the frame', () => {
  /** A's Step2 with B's block first, its first item's content `bContent` (null: unchanged), and A's own text item
   *  turned into a shadow-only violation: a matched relay walks on into it, a mismatch stops at B's id. */
  const probe = (s: Life, a: RemoteClient, bContent: string | null) =>
    rewritten(s, a, (blocks) => {
      const bi = blocks.findIndex((b) => b.client === B_ID);
      const [bBlock] = blocks.splice(bi, 1);
      blocks.unshift(bBlock);
      if (bContent !== null) bBlock.structs[0] = cloneItem(bBlock.structs[0] as Y.Item, { content: new Y.ContentString(bContent) });
      const aBlock = blockOf(blocks, A_ID);
      const it = aBlock.structs[0] as Y.Item;
      aBlock.structs[0] = cloneItem(it, { content: new Y.ContentAny(Array.from((it.content as Y.ContentString).str)) });
    });

  it('a right guess refused for another rule burns the relayer (logged `matched`): never a free confirmation', () => {
    const l1 = lifetime1();
    const { s } = claimed(l1);
    const before = s.state();
    const answer = s.send(s.conn('A'), probe(s, l1.a, null));
    expect(answer).not.toBe(UNRESOLVED_REASON); // the oracle the budget must pay for: a different answer than a miss
    expect(answer).toMatch(/^ccc:collab-update-refused:/);
    expect(s.lastClaim()).toBe('matched');
    expect(sameBytes(s.state(), before)).toBe(true);
    // the one answer is spent: the next probe, right or not, is never compared
    expectUnresolved(s, s.conn('A'), s.step2(l1.a.doc), 'burned');
  });

  it('a wrong guess in the same probe is a mismatch, burned too', () => {
    const l1 = lifetime1();
    const { s } = claimed(l1);
    expect(s.send(s.conn('A'), probe(s, l1.a, 'B-lozt '))).toBe(UNRESOLVED_REASON);
    expect(s.lastClaim()).toBe('mismatch');
    expectUnresolved(s, s.conn('A'), s.step2(l1.a.doc), 'burned');
  });

  it('a match answered `unresolved` for ANOTHER unproven id burns nothing (a miss answers the same); the relay lands next', () => {
    const l1 = lifetime1((c) => {
      relayed(c, c.b, typeAt0('B-lost '), c.a);
      c.m = new RemoteClient(c.life1, M_ID);
      relayed(c, c.m, typeAt0('M-lost '), c.a); // M's lost edit: M announces, never sends, so it has no claim
      relayed(c, c.a, typeAt0('A-lost '), c.b);
    });
    const { s, aConn } = claimed(l1);
    expect(s.announce(s.conn('M'), M_ID)).toBe('applied');
    expectUnresolved(s, aConn, s.step2(l1.a.doc), 'none'); // B's id matched; M's has no claim
    const { blocks, ds } = blocksOf(s.step2(l1.a.doc));
    expect(s.send(s.conn('A'), encodeStructs(blocks.filter((b) => b.client === B_ID), ds))).toBe('applied');
    expect(s.attestedLines()).toHaveLength(1);
  });
});

describe('#842 attest decodes within bounds: cheap checks first, one owner\'s claim at a time, a per-frame budget', () => {
  const decode = (u: Uint8Array) => Y.decodeUpdate(u) as unknown as DecodedFrame;
  /** B and M each lost a tail that reached A; both claims recorded; A's relay of both. */
  function twoOwners() {
    const l1 = lifetime1((c) => {
      relayed(c, c.b, typeAt0('B-lost '), c.a);
      c.m = new RemoteClient(c.life1, M_ID);
      relayed(c, c.m, typeAt0('M-lost '), c.a);
    });
    const base = docOf(l1.stored);
    const sv = Y.encodeStateVector(base);
    const ledger = new ClaimLedger();
    const claims = new RelayClaims(ledger);
    expect(claims.record('B', new Set([B_ID]), Y.encodeStateAsUpdate(l1.b.doc, sv), [B_ID], 0)).toBe('recorded');
    expect(claims.record('M', new Set([M_ID]), Y.encodeStateAsUpdate(l1.m!.doc, sv), [B_ID, M_ID], 0)).toBe('recorded');
    const relay = Y.encodeStateAsUpdate(l1.a.doc, sv);
    const owners: Record<number, string> = { [B_ID]: 'B', [M_ID]: 'M' };
    const q = (frame: Uint8Array, extra: object = {}) => ({
      relayer: 'A',
      frame: decode(frame),
      candidates: [B_ID, M_ID],
      stateOf: (client: number) => Y.getState(base.store, client),
      ownerOf: (client: number) => owners[client],
      isAwarenessOnly: () => true,
      ownerMayWrite: () => true,
      now: 0,
      ...extra,
    });
    return { l1, base, ledger, claims, relay, q };
  }
  let decodes: jest.SpyInstance;
  beforeEach(() => {
    decodes = jest.spyOn(Y, 'decodeUpdate');
  });
  afterEach(() => decodes.mockRestore());

  it('honest: each owner\'s claim decoded once, and both ids attested', () => {
    const { claims, relay, q } = twoOwners();
    const query = q(relay);
    decodes.mockClear();
    const out = claims.attest(query);
    expect([...out.attested.keys()].sort()).toEqual([B_ID, M_ID].sort());
    expect(decodes).toHaveBeenCalledTimes(2);
  });

  it('a relay past a claim\'s range is answered without decoding it (and burned); a relay-side straddle decodes nothing, burns nothing', () => {
    const { claims, relay, q, base } = twoOwners();
    const { blocks, ds } = blocksOf(relay);
    const block = blockOf(blocks, B_ID);
    const last = block.structs[block.structs.length - 1] as Y.Item;
    block.structs.push(new Y.Item(Y.createID(B_ID, last.id.clock + last.length), null, Y.createID(B_ID, last.id.clock + last.length - 1), null, last.rightOrigin, null, null, new Y.ContentString('X')));
    const longer = encodeStructs(blocks.filter((b) => b.client === B_ID), ds);
    const L = Y.getState(base.store, B_ID);
    const straddle = q(relay, { stateOf: (client: number) => (client === B_ID ? L + 1 : Y.getState(base.store, client)), candidates: [B_ID] });
    const longQuery = q(longer, { candidates: [B_ID] });
    decodes.mockClear();
    expect(claims.attest(straddle).failed.get(B_ID)).toBe('uncovered');
    expect(claims.attest(longQuery).failed.get(B_ID)).toBe('uncovered');
    expect(decodes).not.toHaveBeenCalled();
    expect(claims.attest(q(relay, { candidates: [B_ID] })).failed.get(B_ID)).toBe('burned'); // the range answer was spent
  });

  it('past the frame\'s decode budget an owner\'s ids are not compared (`budget`), and nothing is burned', () => {
    const { claims, relay, q, ledger } = twoOwners();
    const query = q(relay, { decodeBytes: ledger.bytes('B') });
    decodes.mockClear();
    const out = claims.attest(query);
    expect(out.attested.has(B_ID)).toBe(true);
    expect(out.failed.get(M_ID)).toBe('budget');
    expect(decodes).toHaveBeenCalledTimes(1);
    expect(claims.attest(q(relay)).attested.has(M_ID)).toBe(true); // not burned: compared on the next frame
  });
});

describe('#842 the comparator, unit', () => {
  const decode = (u: Uint8Array) => Y.decodeUpdate(u) as unknown as DecodedFrame;

  it('R6: a claim GC matches a relay GC, never a relay Item', () => {
    const at = 10;
    const claim = decode(encodeStructs([{ client: B_ID, clock: at, structs: [new Y.GC(Y.createID(B_ID, at), 3)] }]));
    const gc = decode(encodeStructs([{ client: B_ID, clock: at, structs: [new Y.GC(Y.createID(B_ID, at), 3)] }]));
    const item = decode(encodeStructs([{ client: B_ID, clock: at, structs: [new Y.Item(Y.createID(B_ID, at), null, Y.createID(1, 0), null, null, null, null, new Y.ContentString('abc'))] }]));
    expect(compareRelay(gc, claim, B_ID, at)).toMatchObject({ from: at, to: at + 3, deleted: [], evidence: [] });
    expect(compareRelay(item, claim, B_ID, at)).toBe('mismatch');
  });

  it('verifyAttested: an R4 piece left live, or an R6 GC without evidence, fails; pending clocks are pending', () => {
    const { doc } = (() => {
      const d = new Y.Doc();
      d.clientID = B_ID;
      d.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
      ((d.getXmlFragment('default').get(0) as Y.XmlElement)).insert(0, [new Y.XmlText('abc')]);
      return { doc: d };
    })();
    const textItem = ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as any)._start as Y.Item; // 'abc', live
    const [s0, e0] = [textItem.id.clock, textItem.id.clock + 3];
    const base = { owner: 'B', from: s0, to: e0, evidence: [] };
    expect(verifyAttested(doc.store, B_ID, { ...base, deleted: [[s0, e0]] })).toBe('failed'); // promised deleted, still live
    expect(verifyAttested(doc.store, B_ID, { ...base, deleted: [] })).toBe('ok');
    expect(verifyAttested(doc.store, B_ID, { ...base, to: e0 + 1, deleted: [] })).toBe('pending');
    // R6: evidence from the item's own position in a live parent: none
    expect(verifyAttested(doc.store, B_ID, { ...base, deleted: [], evidence: [{ origin: textItem.id, rightOrigin: null, parent: null }] })).toBe('failed');
    doc.transact(() => doc.getXmlFragment('default').delete(0, 1)); // the paragraph goes: its children are not visible
    expect(verifyAttested(doc.store, B_ID, { ...base, deleted: [[s0, e0]], evidence: [{ origin: textItem.id, rightOrigin: null, parent: null }] })).toBe('ok');
  });
  it('strictEqual: prototype, own-key order and Object.is', () => {
    expect(strictEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }, 0)).toBe(true);
    expect(strictEqual({}, Object.create(null), 0)).toBe(false);
    expect(strictEqual({}, JSON.parse('{"__proto__": null}'), 0)).toBe(false);
    expect(strictEqual(0, -0, 0)).toBe(false);
    expect(strictEqual(Number.NaN, Number.NaN, 0)).toBe(true);
    expect(strictEqual({ a: 1, b: 2 }, { b: 2, a: 1 }, 0)).toBe(false);
    expect(strictEqual([1, , 3], [1, undefined, 3], 0)).toBe(false); // eslint-disable-line no-sparse-arrays
  });

  it('R4 counts only non-empty half-open delete ranges: a zero-length range over a forged piece never makes it "deleted"', () => {
    const { b, stored } = lifetime1();
    const base = docOf(stored);
    const L = Y.getState(base.store, B_ID);
    const claimBytes = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(base));
    const { blocks } = blocksOf(claimBytes);
    const block = blockOf(blocks, B_ID);
    const [head, tail] = splitItem(block.structs[0] as Y.Item, 1);
    block.structs = [cloneItem(head, { content: new Y.ContentString('Q') }), tail];
    const relay = decode(encodeStructs([block], [{ client: B_ID, ranges: [[L, 0]] }]));
    expect(compareRelay(relay, decode(claimBytes), B_ID, L)).toBe('mismatch');
  });

  it('a relay that is the claim matches; one that is not, by any field, never does', () => {
    const { b, stored } = lifetime1();
    const base = docOf(stored);
    const claim = decode(Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(base)));
    const L = Y.getState(base.store, B_ID);
    expect(compareRelay(claim, claim, B_ID, L)).toMatchObject({ from: L, to: L + 'B-lost '.length, deleted: [], evidence: [] });
    expect(compareRelay(claim, claim, B_ID, L + 1)).toBe('uncovered'); // R1: it would straddle
  });

  it('never throws out of attest, and an unknown owner or a malformed claim is no match', () => {
    const claims = new RelayClaims(new ClaimLedger());
    expect(claims.record('B', new Set([B_ID]), new Uint8Array([1, 2, 3]), [B_ID], 0)).toBe('none'); // undecodable: nothing
    const frame = decode(new Uint8Array([0, 0]));
    const q = { relayer: 'A', frame, candidates: [B_ID], stateOf: () => 0, ownerOf: () => 'B', isAwarenessOnly: () => true, ownerMayWrite: () => true, now: 0 };
    expect(claims.attest(q)).toEqual({ attested: new Map(), failed: new Map([[B_ID, 'none']]) });
    expect(claims.attest({ ...q, stateOf: () => { throw new Error('boom'); } })).toEqual({ attested: new Map(), failed: new Map([[B_ID, 'none']]) });
  });
});

function docOf(update: Uint8Array): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, update);
  return d;
}

/** `who` types `text` at the front, and the update live lacks. */
function typeAtFrom(s: Life, who: RemoteClient, text: string): Uint8Array {
  Y.applyUpdate(who.doc, Y.encodeStateAsUpdate(s.live, Y.encodeStateVector(who.doc)));
  const sv = Y.encodeStateVector(s.live);
  who.doc.transact(() => firstText(who.doc).insert(0, text));
  return Y.encodeStateAsUpdate(who.doc, sv);
}
