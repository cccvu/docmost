// #790: who a store attributes an edit to, unchanged by the Hocuspocus 4.7.1 upgrade. The REAL stack (Hocuspocus 4.7.1
// with a websocket editor wired as the gateway does, PersistenceExtension, CollaborationHandler, yjs, the tiptap
// transformer); only the `pages` row and the queues are fakes, as in content-write-passes.spec.ts.
//
// Two things changed under the persistence seam (UPSTREAM_MODIFICATIONS.md #122):
//   - 4.x renamed the store payload's `context` to `lastContext`. Reading the old name throws inside the store, which
//     the seam records as a failure: every store would fail. So `lastUpdatedById` and the `page.updated` broadcast are
//     pinned for both kinds of writer.
//   - 4.x hands a direct connection's context to `onChange` (its `transact` origin carries it). Under 3.4.4 only a
//     websocket editor was a contributor; a /v1, MCP or comment-mark writer never was. Pinned both ways.
const mockTx = { inside: false };
jest.mock('@docmost/db/utils', () => ({
  executeTx: async (_db: unknown, cb: (trx: unknown) => Promise<unknown>) => {
    mockTx.inside = true;
    try {
      return await cb({});
    } finally {
      mockTx.inside = false;
    }
  },
}));

import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { authFrame, FakeSocket, RemoteClient, syncFrame } from '../collab-ingress/collab-ingress.testkit';
import { hasStoreFailure } from './store-failure-registry';
import { memoryHealStore } from './heal-image.testkit';

const PAGE_ID = '00000000-0000-4000-8000-000000000781'; // the testkit's DOC_NAME page
const DOC = `page.${PAGE_ID}`;
const API_USER = { id: 'api-user', name: 'API', avatarUrl: 'a.png' } as never;
const HUMAN = { id: 'human', name: 'Human', avatarUrl: 'h.png' };

const SEED = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'seed' }] }] };

function stack() {
  const seed = TiptapTransformer.toYdoc(SEED as never, 'default', tiptapExtensions);
  const row = {
    id: PAGE_ID,
    slugId: 'slug',
    workspaceId: 'w1',
    spaceId: 's1',
    creatorId: 'creator',
    createdAt: new Date('2020-01-01').toISOString(),
    contributorIds: ['earlier'] as string[],
    content: JSON.parse(JSON.stringify(TiptapTransformer.fromYdoc(seed, 'default'))),
    ydoc: Buffer.from(Y.encodeStateAsUpdate(seed)) as Buffer | null,
  };
  const findById = jest.fn(async () => ({
    ...row,
    content: JSON.parse(JSON.stringify(row.content)),
    ydoc: row.ydoc ? Buffer.from(row.ydoc) : null,
  }));
  const updatePage = jest.fn(async (values: { content: unknown; ydoc: Buffer; lastUpdatedById: string; contributorIds?: string[] }) => {
    row.content = JSON.parse(JSON.stringify(values.content));
    row.ydoc = Buffer.from(values.ydoc);
  });
  const addContributors = jest.fn(async () => undefined);
  const queue = { add: jest.fn(async () => undefined) } as never;
  const persistence = new PersistenceExtension(
    { findById, updatePage } as never,
    memoryHealStore(row) as never, // #840: the heal rows (none: every page here is order-stable)
    queue,
    queue,
    queue,
    { addContributors } as never,
    { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) } as never,
  );
  const auth = {
    async onAuthenticate(data: { token: string }) {
      if (data.token !== 'human') throw new Error('denied');
      return { user: HUMAN };
    },
  };
  const hocuspocus = new Hocuspocus({ quiet: true, extensions: [auth, persistence], debounce: 60_000, maxDebounce: 60_000 } as never);
  const handlers = new CollaborationHandler().getHandlers(hocuspocus);
  // The `page.updated` broadcast a store sends to every editor of the document.
  const broadcasts: Array<{ type: string; lastUpdatedById?: string; lastUpdatedBy?: { id: string; name: string } }> = [];
  const capture = (doc: { broadcastStateless: (p: string) => void }) => {
    const original = doc.broadcastStateless.bind(doc);
    doc.broadcastStateless = (p: string) => {
      broadcasts.push(JSON.parse(p));
      original(p);
    };
  };
  return { row, updatePage, addContributors, hocuspocus, handlers, broadcasts, capture };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const sockets: FakeSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close(1000, 'test over');
  await settle();
  jest.restoreAllMocks();
});

describe('#790 store attribution under Hocuspocus 4.7.1', () => {
  it('a direct (API) write is attributed to its caller but never makes the caller a contributor', async () => {
    const s = stack();
    await s.handlers.updatePageContent(DOC, {
      prosemirrorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'from the API' }] }] },
      operation: 'append',
      user: API_USER,
    });
    expect(s.updatePage).toHaveBeenCalledTimes(1);
    const values = s.updatePage.mock.calls[0][0];
    expect(values.lastUpdatedById).toBe('api-user');
    expect(values.contributorIds).toEqual(['earlier', 'creator']); // no 'api-user'
    expect(s.addContributors).toHaveBeenCalledWith(PAGE_ID, []);
    expect(JSON.stringify(s.row.content)).toContain('from the API');
  });

  it('a websocket editor is attributed and becomes a contributor; the broadcast names them', async () => {
    const s = stack();
    const sock = new FakeSocket();
    sockets.push(sock);
    sock.connect(s.hocuspocus);
    sock.deliver(authFrame('human'));
    await settle();
    const live = s.hocuspocus.documents.get(DOC)!;
    expect(live).toBeDefined();
    s.capture(live as never);
    const edit = new RemoteClient(live).edit(live, (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.XmlText('typed ')]));
    sock.deliver(syncFrame(edit));
    await settle();
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true }); // runs the debounced store now
    expect(hasStoreFailure(live)).toBe(false);
    expect(s.updatePage).toHaveBeenCalledTimes(1);
    const values = s.updatePage.mock.calls[0][0];
    expect(values.lastUpdatedById).toBe('human');
    expect(values.contributorIds).toEqual(['earlier', 'human', 'creator']);
    expect(s.broadcasts).toEqual([
      expect.objectContaining({ type: 'page.updated', lastUpdatedById: 'human', lastUpdatedBy: { id: 'human', name: 'Human', avatarUrl: 'h.png' } }),
    ]);
  });

  it('an API write while a human is typing: the store names the API caller, and only the human is a contributor', async () => {
    const s = stack();
    const sock = new FakeSocket();
    sockets.push(sock);
    sock.connect(s.hocuspocus);
    sock.deliver(authFrame('human'));
    await settle();
    const live = s.hocuspocus.documents.get(DOC)!;
    s.capture(live as never);
    sock.deliver(syncFrame(new RemoteClient(live).edit(live, (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.XmlText('typed ')]))));
    await settle();
    await s.handlers.updatePageContent(DOC, {
      prosemirrorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'from the API' }] }] },
      operation: 'append',
      user: API_USER,
    });
    // The write's own store persists both (the documented #282 residual: the human's unsaved edit rides it).
    expect(s.updatePage).toHaveBeenCalledTimes(1);
    const values = s.updatePage.mock.calls[0][0];
    expect(values.lastUpdatedById).toBe('api-user');
    expect(values.contributorIds).toEqual(['earlier', 'human', 'creator']);
    expect(s.broadcasts).toEqual([expect.objectContaining({ lastUpdatedById: 'api-user', lastUpdatedBy: { id: 'api-user', name: 'API', avatarUrl: 'a.png' } })]);
  });
});
