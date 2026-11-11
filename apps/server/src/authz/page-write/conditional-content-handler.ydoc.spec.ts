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

import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { stableHash } from './stable-hash';
import { scopedWriteKey, WRITE_IDEM_MAP } from './write-idem';

const DOC = 'page.77777777-7777-4777-8777-777777777777';
const USER = { id: 'user-1' } as never;
const paras = (...texts: string[]): Para[] => texts.map((text) => ({ type: 'paragraph', text }));

/** A resident real Y.Doc behind a DirectConnection-shaped fake (transact runs the callback, as Hocuspocus does). */
const setup = (opts: { beforeCallback?: (doc: Y.Doc) => void } = {}) => {
  const doc = new Y.Doc();
  toFragment(doc, paras('old one', 'old two'));
  const connection = {
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
