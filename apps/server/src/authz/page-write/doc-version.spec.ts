// #716: the live digest's memo, against REAL Yjs documents (only the tiptap transformer — whose module graph jest
// cannot parse — is replaced, by a reader of the real fragment).
import * as Y from 'yjs';

jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: { fromYdoc: (doc: Y.Doc) => doc.getXmlFragment('default').toJSON() },
}));

import { docGeneration, liveContentDigest, memoizedDigest, warmLiveContentDigest } from './doc-version';
import { stableHash } from './stable-hash';

const docWith = (...texts: string[]) => {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(
    0,
    texts.map((t) => {
      const el = new Y.XmlElement('paragraph');
      el.insert(0, [new Y.XmlText(t)]);
      return el;
    }),
  );
  return doc;
};
const read = (doc: Y.Doc) => stableHash(doc.getXmlFragment('default').toJSON());

describe('#716 doc-version: the live digest, memoized per document state', () => {
  it('an unchanged document is walked once, however often it is asked', () => {
    const doc = docWith('a', 'b');
    const compute = jest.fn(read);
    const first = memoizedDigest(doc, compute);
    expect(memoizedDigest(doc, compute)).toBe(first);
    expect(memoizedDigest(doc, compute)).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('a DELETE-ONLY remote update (state vector unchanged) invalidates it — the case a state-vector key would miss', () => {
    const doc = docWith('a', 'b');
    const compute = jest.fn(read);
    const before = memoizedDigest(doc, compute);
    const sv = Y.encodeStateVector(doc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerSv = Y.encodeStateVector(peer);
    peer.getXmlFragment('default').delete(0, 1);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, peerSv));
    expect(Buffer.from(Y.encodeStateVector(doc))).toEqual(Buffer.from(sv)); // a deletion leaves it as it was
    const after = memoizedDigest(doc, compute);
    expect(after).not.toBe(before);
    expect(after).toBe(read(doc));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('every local edit bumps the generation; an empty transaction too (a recompute, never a stale answer)', () => {
    const doc = docWith('a');
    const g0 = docGeneration(doc);
    doc.getXmlFragment('default').delete(0, 1);
    const g1 = docGeneration(doc);
    expect(g1).toBeGreaterThan(g0);
    doc.transact(() => undefined);
    expect(docGeneration(doc)).toBeGreaterThan(g1);
  });

  it('a transaction during the computation stores the digest under the OLD generation, so the next read recomputes', () => {
    const doc = docWith('a');
    let calls = 0;
    const compute = (d: Y.Doc) => {
      calls++;
      const digest = read(d);
      if (calls === 1) d.transact(() => undefined); // something ran mid-compute
      return digest;
    };
    memoizedDigest(doc, compute);
    memoizedDigest(doc, compute);
    expect(calls).toBe(2);
  });

  it('a different document object (unloaded, reloaded) is computed from scratch', () => {
    const a = docWith('x');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const compute = jest.fn(read);
    memoizedDigest(a, compute);
    memoizedDigest(b, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a document whose transactions cannot be observed is never memoized', () => {
    const opaque = { getXmlFragment: () => ({}) } as unknown as Y.Doc;
    const compute = jest.fn(() => 'd');
    memoizedDigest(opaque, compute);
    memoizedDigest(opaque, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('the memo is keyed by the compute function: a different function never reads the other one\'s digest', () => {
    const doc = docWith('a');
    const first = jest.fn(() => 'first');
    const second = jest.fn(() => 'second');
    expect(memoizedDigest(doc, first)).toBe('first');
    expect(memoizedDigest(doc, second)).toBe('second');
    expect(memoizedDigest(doc, second)).toBe('second');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('liveContentDigest hits its memo across calls (a stable function reference)', () => {
    const doc = docWith('a', 'b');
    const spy = jest.spyOn(JSON, 'stringify');
    const before = spy.mock.calls.length;
    liveContentDigest(doc);
    const afterFirst = spy.mock.calls.length;
    liveContentDigest(doc);
    expect(spy.mock.calls.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(before);
    spy.mockRestore();
  });

  it('liveContentDigest is stableHash(fromYdoc(doc)) — the same value the settle hands out', () => {
    const doc = docWith('a', 'b');
    expect(liveContentDigest(doc)).toBe(read(doc));
  });
});

describe('#731 F4 warmLiveContentDigest', () => {
  it('walks only when the memo does not hold the current generation, and then the pre-check is a hit', () => {
    const doc = docWith('a');
    expect(warmLiveContentDigest(doc)).toBe(true); // cold: computed
    expect(warmLiveContentDigest(doc)).toBe(false); // hit
    expect(liveContentDigest(doc)).toBe(read(doc));
    doc.transact(() => doc.getXmlFragment('default').delete(0, 1)); // an edit (delete-only) during the yield
    expect(warmLiveContentDigest(doc)).toBe(true); // the memo is generation-keyed: stale is never a hit
    expect(liveContentDigest(doc)).toBe(read(doc));
  });

  it('another function in the memo slot is not a hit; an unobservable document is never warmed', () => {
    const doc = docWith('a');
    memoizedDigest(doc, () => 'other');
    expect(warmLiveContentDigest(doc)).toBe(true);
    expect(warmLiveContentDigest({} as never)).toBe(false);
  });
});
