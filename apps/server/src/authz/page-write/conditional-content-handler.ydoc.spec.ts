// #716: the handler's write against a REAL Y.Doc (yjs itself is not mocked here; only the tiptap transformer, whose
// module graph jest cannot parse, is replaced by a tiny paragraph-only one that builds and reads real Yjs types).
import * as Y from 'yjs';

type Para = { type: 'paragraph'; text: string };
const toFragment = (doc: Y.Doc, paras: Para[]) =>
  doc.getXmlFragment('default').insert(
    doc.getXmlFragment('default').length,
    paras.map((p) => {
      const el = new Y.XmlElement('paragraph');
      el.insert(0, [new Y.XmlText(p.text)]);
      return el;
    }),
  );
const readFragment = (doc: Y.Doc) => ({
  type: 'doc',
  content: doc
    .getXmlFragment('default')
    .toArray()
    .map((el) => ({ type: 'paragraph', text: (el as Y.XmlElement).toArray().map((t) => t.toString()).join('') })),
});

jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: {
    fromYdoc: (doc: Y.Doc) => readFragment(doc),
    toYdoc: (json: { content: Para[] }) => {
      const d = new Y.Doc();
      toFragment(d, json.content);
      return d;
    },
  },
}));
jest.mock('../../collaboration/collaboration.util', () => ({
  prosemirrorNodeToYElement: (p: Para) => {
    const el = new Y.XmlElement('paragraph');
    el.insert(0, [new Y.XmlText(p.text)]);
    return el;
  },
  tiptapExtensions: [],
}));
jest.mock('../../collaboration/yjs.util', () => ({ setYjsMark: jest.fn(), updateYjsMarkAttribute: jest.fn() }));
// #731: the content builder, paragraph-only like the transformer above (the real one is pinned against toYdoc by
// prelim-content.parity.spec.ts and runs unmocked in content-write-passes.spec.ts).
jest.mock('./prelim-content', () => ({
  buildPrelimContent: (json: { content: Para[] }) =>
    json.content.map((p) => {
      const el = new Y.XmlElement('paragraph');
      el.insert(0, [new Y.XmlText(p.text)]);
      return el;
    }),
}));

import { InternalServerErrorException } from '@nestjs/common';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PageCompactingException } from './compaction';
import * as registry from './compaction-registry';
import { liveWedged } from './compaction-registry';
import { stableHash } from './stable-hash';
import { storeGenerationOf } from './store-failure-registry';
import { scopedWriteKey, WRITE_IDEM_MAP } from './write-idem';

const DOC = 'page.77777777-7777-4777-8777-777777777777';
const USER = { id: 'user-1' } as never;
const paras = (...texts: string[]): Para[] => texts.map((text) => ({ type: 'paragraph', text }));

/** A resident real Y.Doc behind a DirectConnection-shaped fake (transact runs the callback, as Hocuspocus does). */
const setup = (opts: { beforeCallback?: (doc: Y.Doc) => void; gated?: boolean } = {}) => {
  const doc = new Y.Doc();
  toFragment(doc, paras('old one', 'old two'));
  const connection = {
    ...(opts.gated ? { document: doc } : {}), // #847: what the write gate reads (#827 seam #2)
    transact: async (fn: (d: Y.Doc) => void) => {
      opts.beforeCallback?.(doc);
      fn(doc);
    },
    disconnect: async () => undefined,
  };
  const hocuspocus = { documents: new Map([[DOC, doc]]), openDirectConnection: async () => connection };
  const handlers = new CollaborationHandler().getHandlers(hocuspocus as never);
  return { doc, handlers };
};

describe('#716 content writes against a real Y.Doc', () => {
  it('a replace is ONE update event, and no observer ever sees the empty fragment between delete and apply', async () => {
    const { doc, handlers } = setup();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const seenLengths: number[] = [];
    doc.getXmlFragment('default').observeDeep(() => seenLengths.push(doc.getXmlFragment('default').length));
    // A peer replaying the broadcasts one by one: what a connected editor would render after each.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerLengths: number[] = [];
    doc.on('update', (u: Uint8Array) => {
      Y.applyUpdate(peer, u);
      peerLengths.push(peer.getXmlFragment('default').length);
    });

    const json = { type: 'doc', content: paras('new one', 'new two', 'new three') };
    await expect(
      handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: json,
        operation: 'replace',
        user: USER,
        expectedContentHash: stableHash(readFragment(doc)),
      }),
    ).resolves.toEqual({ applied: true });

    expect(updates).toHaveLength(1);
    expect(seenLengths).toEqual([3]);
    expect(peerLengths).toEqual([3]);
    expect(readFragment(doc)).toEqual({ type: 'doc', content: paras('new one', 'new two', 'new three') });
    expect(readFragment(peer)).toEqual(readFragment(doc));
  });

  it('the native updatePageContent replace is one update event too', async () => {
    const { doc, handlers } = setup();
    let events = 0;
    doc.on('update', () => events++);
    await handlers.updatePageContent(DOC, {
      prosemirrorJson: { type: 'doc', content: paras('x') },
      operation: 'replace',
      user: USER,
    });
    expect(events).toBe(1);
    expect(readFragment(doc).content).toEqual(paras('x'));
  });

  it('CAS: a REAL delete-only remote update between the pre-check and the transaction → 412, nothing more mutated', async () => {
    let deleted = false;
    const { doc, handlers } = setup({
      beforeCallback: (d) => {
        // A peer deletes a paragraph: the content changes, the state vector does NOT.
        const before = Y.encodeStateVector(d);
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(d));
        const sv = Y.encodeStateVector(peer);
        peer.getXmlFragment('default').delete(1, 1);
        Y.applyUpdate(d, Y.encodeStateAsUpdate(peer, sv));
        expect(Buffer.from(Y.encodeStateVector(d))).toEqual(Buffer.from(before));
        deleted = true;
      },
    });
    const digestBefore = stableHash(readFragment(doc));
    await expect(
      handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: { type: 'doc', content: paras('appended') },
        operation: 'append',
        user: USER,
        expectedContentHash: digestBefore,
        idempotencyKey: 'K',
      }),
    ).resolves.toEqual({ applied: false, reason: 'precondition' });
    expect(deleted).toBe(true);
    expect(readFragment(doc).content).toEqual(paras('old one')); // the remote delete only: no append
    expect(doc.getMap(WRITE_IDEM_MAP).size).toBe(0); // no key recorded on a refusal
  });

  it('an append with a matching digest records the key in the SAME update as the content', async () => {
    const { doc, handlers } = setup();
    const oldState = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    await expect(
      handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: { type: 'doc', content: paras('appended') },
        operation: 'append',
        user: USER,
        expectedContentHash: stableHash(readFragment(doc)),
        idempotencyKey: 'K',
      }),
    ).resolves.toEqual({ applied: true });
    expect(updates).toHaveLength(1);
    // Replaying that ONE update on a copy of the old state yields both the content and the key (#429 atomicity).
    const copy = new Y.Doc();
    Y.applyUpdate(copy, oldState);
    Y.applyUpdate(copy, updates[0]);
    expect(readFragment(copy).content).toEqual(paras('old one', 'old two', 'appended'));
    expect(copy.getMap(WRITE_IDEM_MAP).has(scopedWriteKey('user-1', 'K').entry)).toBe(true);
  });

  // #781 lineage (ledger-userid-exposure), end to end through the real handler and a real Y.Doc: the bytes that
  // every viewer syncs, persist and reload (tombstones included once the entry is pruned) never hold the acting
  // user's id or the caller's key. Control: a pre-fix raw entry in the same doc DOES show up in the same bytes.
  it('the persisted state carries neither the user id nor the caller key, and the h1 entry is present', async () => {
    const KEY = 'attachment-embed:0193b000-0000-7000-8000-0000000000aa';
    const { doc, handlers } = setup();
    await expect(
      handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: { type: 'doc', content: paras('appended') },
        operation: 'append',
        user: USER,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ applied: true });
    const copy = new Y.Doc(); // what pages.ydoc / a browser's IndexedDB holds
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(copy.getMap(WRITE_IDEM_MAP).has(scopedWriteKey('user-1', KEY).entry)).toBe(true); // mandatory: not vacuous
    // Age the entry so the next keyed write prunes it, leaving only its tombstone.
    doc.getMap<number>(WRITE_IDEM_MAP).set(scopedWriteKey('user-1', KEY).entry, 0);
    await handlers.conditionalUpdatePageContent(DOC, {
      prosemirrorJson: { type: 'doc', content: paras('again') },
      operation: 'append',
      user: USER,
      idempotencyKey: 'v2:next',
    });
    expect(doc.getMap(WRITE_IDEM_MAP).has(scopedWriteKey('user-1', KEY).entry)).toBe(false); // pruned
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    expect(state.includes('user-1')).toBe(false);
    expect(state.includes('attachment-embed')).toBe(false);
    expect(state.includes('v2:next')).toBe(false);
    // Control: the same doc with a pre-fix raw entry leaks both, so the assertions above can fail.
    doc.getMap<number>(WRITE_IDEM_MAP).set(`user-1\u0000${KEY}`, Date.now());
    const leaked = Buffer.from(Y.encodeStateAsUpdate(doc));
    expect(leaked.includes('user-1')).toBe(true);
    expect(leaked.includes('attachment-embed')).toBe(true);
  });
});

/**
 * #847 G4: a WEDGED live document (Yjs's cleanup of a transaction threw, M2) integrates later transactions but never
 * emits their update, so nothing schedules a store and the generation never moves. The write gate refuses every
 * direct write to it (503 engine_busy, nothing changed), the settle fails closed, and a write that itself wedged live
 * answers outcome-unknown, never a success.
 */
describe('#847 a wedged live document takes no API write, and a write that wedges it is never a success', () => {
  /** A stranded keyed piece on paragraph 0 (client 9's two-value item, its second value deleted): K:0 live, not the head. */
  const strand = (doc: Y.Doc) => {
    const peer = new Y.Doc();
    peer.clientID = 9;
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(peer);
    (peer.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('textAlign', 'left');
    const item = (peer.getXmlFragment('default').get(0) as Y.XmlElement)._map.get('textAlign')!;
    (item.content as Y.ContentAny).arr.push('center'); // what a pre-#847 frame could store
    item.length = 2;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, sv));
    Y.applyUpdate(doc, new Uint8Array([0, 1, 9, 1, 1, 1])); // delete 9:1 only (a delete-set-only frame)
  };
  const wedge = (doc: Y.Doc) => {
    strand(doc);
    try {
      doc.getXmlFragment('default').delete(0, 1); // a parent delete over the stranded piece
    } catch {
      // Yjs's cleanup threw
    }
    expect(liveWedged(doc)).toBe(true);
  };
  /** Transactions begun on `doc` from now on, and its store generation. */
  const watch = (doc: Y.Doc) => {
    let transactions = 0;
    doc.on('beforeTransaction', () => transactions++);
    const generation = storeGenerationOf(doc);
    return { transactions: () => transactions, generationMoved: () => storeGenerationOf(doc) !== generation };
  };
  const write = { prosemirrorJson: { type: 'doc', content: paras('new') }, operation: 'replace', user: USER };

  it('an API write and a conditional write on a wedged document: 503 engine_busy / error, no Yjs transaction, the generation unchanged', async () => {
    const { doc, handlers } = setup({ gated: true });
    wedge(doc);
    const w = watch(doc);
    const before = readFragment(doc);
    await expect(handlers.updatePageContent(DOC, write)).rejects.toBeInstanceOf(PageCompactingException);
    await expect(handlers.updatePageContent(DOC, write)).rejects.toMatchObject({ response: { code: 'engine_busy' } });
    await expect(handlers.conditionalUpdatePageContent(DOC, write)).resolves.toEqual({ applied: false, reason: 'error' });
    await expect(handlers.setCommentMark(DOC, { yjsSelection: {} as never, commentId: 'c', resolved: false, user: USER } as never)).rejects.toBeInstanceOf(PageCompactingException);
    expect(w.transactions()).toBe(0);
    expect(w.generationMoved()).toBe(false);
    expect(readFragment(doc)).toEqual(before);
    expect(liveWedged(doc)).toBe(true); // never unwedged in place
  });

  it('the settle on a wedged document fails closed (the 503), with no Yjs transaction', async () => {
    const { doc } = setup();
    Object.assign(doc, { saveMutex: { runExclusive: async (f: () => Promise<unknown>) => f(), isLocked: () => false } });
    const debouncer = { isDebounced: () => false, executeNow: async () => undefined, isCurrentlyExecuting: () => false };
    const handlers = new CollaborationHandler().getHandlers({ documents: new Map([[DOC, doc]]), debouncer } as never);
    await expect(handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true }); // control
    wedge(doc);
    const w = watch(doc);
    await expect(handlers.flushPageContent(DOC, { withDigest: true })).resolves.toEqual({ flushed: false, reason: 'error' });
    expect(w.transactions()).toBe(0);
  });

  it('a write that wedges live itself answers outcome-unknown (500 write_outcome_unknown / applied_unconfirmed), never a success', async () => {
    const native = setup();
    strand(native.doc);
    expect(liveWedged(native.doc)).toBe(false);
    let err: unknown;
    await native.handlers.updatePageContent(DOC, write).catch((e) => (err = e));
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect((err as InternalServerErrorException).getResponse()).toMatchObject({ code: 'write_outcome_unknown' });
    expect(liveWedged(native.doc)).toBe(true); // the replace's delete of the paragraph wedged it
    const conditional = setup();
    strand(conditional.doc);
    await expect(
      conditional.handlers.conditionalUpdatePageContent(DOC, { ...write, expectedContentHash: stableHash(readFragment(conditional.doc)) }),
    ).resolves.toEqual({ applied: false, reason: 'applied_unconfirmed' });
    expect(liveWedged(conditional.doc)).toBe(true);
  });

  it('control: without the wedge checks, a write to a wedged document answers success, and no update (so no store) ever follows', async () => {
    const { doc, handlers } = setup();
    wedge(doc);
    let updates = 0;
    doc.on('update', () => updates++);
    // the one predicate blinded: the gate (seam #2) and the handler's post-apply check both read it
    const blind = jest.spyOn(registry, 'liveWedged').mockReturnValue(false);
    try {
      await expect(handlers.updatePageContent(DOC, write)).resolves.toBeUndefined();
    } finally {
      blind.mockRestore();
    }
    expect(readFragment(doc).content).toEqual(paras('new')); // applied to live...
    expect(updates).toBe(0); // ...and never emitted: the row would never get it
  });
});
