// The handler module pulls the tiptap/yjs graph (lib0 ESM) that jest cannot parse. Stub the heavy
// value-imports; `@hocuspocus/server` is type-only here and is elided by ts-jest. TiptapTransformer is
// stubbed with a controllable serializer so we can drive the digest comparison deterministically.
const fromYdoc = jest.fn();
jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: {
    fromYdoc: (...a: unknown[]) => fromYdoc(...a),
    toYdoc: jest.fn(() => ({})),
  },
}));
jest.mock('yjs', () => ({
  applyUpdate: jest.fn(),
  encodeStateAsUpdate: jest.fn(() => new Uint8Array()),
}));
jest.mock('../../collaboration/collaboration.util', () => ({
  prosemirrorNodeToYElement: jest.fn((n: unknown) => n),
  tiptapExtensions: [],
}));
jest.mock('../../collaboration/yjs.util', () => ({
  setYjsMark: jest.fn(),
  updateYjsMarkAttribute: jest.fn(),
}));

import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { stableHash } from './stable-hash';

/**
 * Compare-and-swap content write (#282, ADR 0017).
 *
 * The guarantee: the version check and the mutation happen in the SAME synchronous transaction callback,
 * so a websocket frame — a person typing — cannot land between them. These tests pin that, plus the two
 * branches of the residency rule that decides whether the check applies at all.
 */
describe('CollaborationHandler.conditionalUpdatePageContent (#282)', () => {
  const DOC = 'page.22222222-2222-4222-8222-222222222222';
  const LIVE = { type: 'doc', content: [{ type: 'paragraph' }] };
  const USER = { id: 'user-1' };

  /** A fragment that records the operations performed on it, so we can assert nothing ran on a refusal. */
  const makeFragment = (ops: string[]) => ({
    length: 1,
    delete: jest.fn(() => ops.push('delete')),
    insert: jest.fn(() => ops.push('insert')),
  });

  const build = (opts: { resident: boolean }) => {
    const ops: string[] = [];
    const fragment = makeFragment(ops);
    const doc = { getXmlFragment: jest.fn(() => fragment) };
    const documents = new Map<string, unknown>();
    if (opts.resident) documents.set(DOC, doc);

    const connection = {
      transact: jest.fn(async (fn: (d: unknown) => void) => {
        ops.push('transact');
        fn(doc);
      }),
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = {
      documents,
      openDirectConnection: jest.fn(async () => connection),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;
    return { handler, ops, connection, hocuspocus, doc };
  };

  beforeEach(() => {
    fromYdoc.mockReset();
    fromYdoc.mockReturnValue(LIVE);
  });

  const payload = (expectedContentHash: string, operation = 'replace') => ({
    prosemirrorJson: { type: 'doc', content: [] },
    operation,
    user: USER as never,
    expectedContentHash,
  });

  it('applies the write when the live document still matches the expected digest', async () => {
    const { handler, ops } = build({ resident: true });
    await expect(handler(DOC, payload(stableHash(LIVE)))).resolves.toEqual({
      applied: true,
    });
    expect(ops).toContain('delete'); // the replace actually ran
  });

  // THE guarantee. A stale digest means someone edited the document after the caller read it.
  it('refuses the write when the live document no longer matches', async () => {
    const { handler } = build({ resident: true });
    await expect(
      handler(DOC, payload(stableHash({ different: true }))),
    ).resolves.toEqual({
      applied: false,
      reason: 'precondition',
    });
  });

  // A refusal must be inert: no mutation at all, so the refused write cannot even rotate the page version
  // (which would make the caller's next attempt fail for a second, spurious reason).
  it('mutates nothing when it refuses', async () => {
    const { handler, ops, doc } = build({ resident: true });
    await handler(DOC, payload(stableHash({ different: true })));
    expect(ops).not.toContain('delete');
    expect(ops).not.toContain('insert');
    expect(doc.getXmlFragment).not.toHaveBeenCalled();
  });

  // The atomicity argument, made testable: the comparison must happen INSIDE the transaction callback, not
  // before it. A check outside transact() would reintroduce exactly the race this endpoint exists to close.
  it('compares INSIDE the transaction, before the mutation', async () => {
    const order: string[] = [];
    fromYdoc.mockImplementation(() => {
      order.push('compare');
      return LIVE;
    });
    const doc = {
      getXmlFragment: jest.fn(() => ({
        length: 0,
        delete: jest.fn(),
        insert: jest.fn(() => order.push('mutate')),
      })),
    };
    const connection = {
      transact: jest.fn(async (fn: (d: unknown) => void) => {
        order.push('transact:start');
        fn(doc);
        order.push('transact:end');
      }),
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = {
      documents: new Map([[DOC, doc]]),
      openDirectConnection: jest.fn(async () => connection),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;

    await handler(DOC, payload(stableHash(LIVE), 'append'));
    expect(order).toEqual([
      'transact:start',
      'compare',
      'mutate',
      'transact:end',
    ]);
  });

  // Residency branch A: nobody has the page open, so there is no unpersisted delta and the caller's
  // row-based check was already authoritative. Comparing here would 412 forever on API-created pages,
  // whose stored content is verbatim while this serialization is normalized.
  it('skips the comparison when the document was NOT resident', async () => {
    const { handler, ops } = build({ resident: false });
    await expect(
      handler(DOC, payload('a-digest-that-matches-nothing')),
    ).resolves.toEqual({
      applied: true,
    });
    expect(ops).toContain('delete');
    expect(fromYdoc).not.toHaveBeenCalled();
  });

  // Residency must be read BEFORE opening the connection — opening it loads the document, which would
  // flip the answer and silently disable the check for every page that was idle.
  it('reads residency before opening the connection', async () => {
    const order: string[] = [];
    const documents = { has: jest.fn(() => (order.push('has'), true)) };
    const connection = {
      transact: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = {
      documents,
      openDirectConnection: jest.fn(
        async () => (order.push('open'), connection),
      ),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;

    await handler(DOC, payload('x'));
    expect(order).toEqual(['has', 'open']);
  });

  // Cross-node, a throwing custom-event handler never publishes its RedisSync reply and hangs the caller
  // until the custom-event TTL. It must report instead — and "error" must NOT read as applied.
  it('reports an error outcome instead of throwing when the transaction fails', async () => {
    const hocuspocus = {
      documents: new Map([[DOC, {}]]),
      openDirectConnection: jest.fn(async () => {
        throw new Error('collab node exploded');
      }),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;

    await expect(handler(DOC, payload('x'))).resolves.toEqual({
      applied: false,
      reason: 'error',
    });
  });

  it('always disconnects, even when it refuses the write', async () => {
    const { handler, connection } = build({ resident: true });
    await handler(DOC, payload(stableHash({ different: true })));
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});
