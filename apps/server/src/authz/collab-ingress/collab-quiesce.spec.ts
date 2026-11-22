// wiki-v2 #919 (F7): the collab quiesce and the kept failed store, through the REAL stack: the gateway (its Hocuspocus
// 4.7.1, the update guard extension, the socket bounds), the real PersistenceExtension and CollaborationHandler, yjs
// and the tiptap transformer. Only the `pages` row, the queues and the transaction are fakes (as in
// persistence-attribution.spec.ts). RedisSync is off (the standalone path), so a socket is wired as the gateway's
// direct path wires it. jest's fake clock (nextTick and queueMicrotask real), so the 10 s debounce and the drain
// budgets are exact.
jest.mock('@docmost/db/utils', () => ({
  executeTx: async (_db: unknown, cb: (trx: unknown) => Promise<unknown>) => cb({}),
}));

import * as Y from 'yjs';
import { Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { authFrame, DOC_NAME, FakeSocket, MSG, readServerFrame, RemoteClient, syncFrame } from './collab-ingress.testkit';
import { CollabSocketBounds, COLLAB_DRAIN_TOKEN } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';
import { CollabQuiescedException, SHUTDOWN_DRAIN_BUDGET_MS } from './collab-quiesce';
import { COLLAB_PAGE_COMPACTING_REASON } from './collab-reasons';
import { memoryHealStore } from '../page-write/heal-image.testkit';
import { hasStoreFailure, recordStoreFailure } from '../page-write/store-failure-registry';
import { markSuperseded, resumeCompactionsForTests } from '../page-write/compaction-registry';
import * as keepFailedStore from '../page-write/keep-failed-store';

const PAGE_ID = DOC_NAME.replace(/^page\./, '');
const SEED = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'seed' }] }] };

/** Run timers due by `ms` from now, and the promise chains between them. */
const advance = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 100; i++) await jest.advanceTimersByTimeAsync(5);
};

/** Await `p` while the fake clock's immediates and zero-delay timers run (the stores yield with setImmediate). */
async function run<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 50 && !done; i++) await advance();
  return p;
}

const last = <T,>(a: T[]): T => a[a.length - 1];

const paragraph = (t: string) => (f: Y.XmlFragment) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(t)]);
  f.insert(f.length, [p]);
};
const rowText = (ydoc: Uint8Array | null): string => {
  const d = new Y.Doc();
  if (ydoc) Y.applyUpdate(d, ydoc);
  return d.getXmlFragment('default').toString();
};

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
  const db = { down: false };
  const findById = jest.fn(async () => ({
    ...row,
    content: JSON.parse(JSON.stringify(row.content)),
    ydoc: row.ydoc ? Buffer.from(row.ydoc) : null,
  }));
  const updatePage = jest.fn(async (values: { content: unknown; ydoc: Buffer; lastUpdatedById: string; contributorIds?: string[] }) => {
    if (db.down) throw new Error('connection terminated unexpectedly');
    row.content = JSON.parse(JSON.stringify(values.content));
    row.ydoc = Buffer.from(values.ydoc);
    if (values.contributorIds) row.contributorIds = values.contributorIds;
  });
  const queue = { add: jest.fn(async () => undefined) } as never;
  const persistence = new PersistenceExtension(
    { findById, updatePage } as never,
    memoryHealStore(row) as never,
    queue,
    queue,
    queue,
    { addContributors: jest.fn(async () => undefined) } as never,
    { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) } as never,
  );
  const drainLines: string[] = [];
  const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn: () => undefined }), drainLog: { log: (m) => drainLines.push(m) } });
  const auth = {
    async onAuthenticate({ token }: { token: string }) {
      return { user: { id: token, name: token, avatarUrl: '' } };
    },
  };
  const gateway = new CollaborationGateway(
    auth as never,
    persistence,
    {} as never,
    { getRedisUrl: () => 'redis://localhost:6379', isCollabDisableRedis: () => true } as never,
    { getHandlers: () => ({}) } as never,
    bounds,
  );
  const hp = (gateway as unknown as { hocuspocus: import('@hocuspocus/server').Hocuspocus }).hocuspocus;
  const handlers = new CollaborationHandler().getHandlers(hp);
  const sockets: FakeSocket[] = [];
  const connect = (token: string) => {
    const sock = new FakeSocket();
    sockets.push(sock);
    gateway.handleConnection(sock as never, { method: 'GET', url: '/collab', headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never);
    sock.deliver(authFrame(token));
    return sock;
  };
  const live = () => hp.documents.get(DOC_NAME) as unknown as Y.Doc | undefined;
  const editFrame = (t: string) => {
    const doc = live()!;
    return syncFrame(new RemoteClient(doc).edit(doc, paragraph(t)));
  };
  const resident = () => hp.documents.size + hp.loadingDocuments.size;
  return { row, db, findById, updatePage, bounds, gateway, hp, handlers, connect, live, editFrame, resident, drainLines, sockets };
}
type Stack = ReturnType<typeof stack>;

/** An editor who typed `t` and whose store FAILED (the database was down at the debounce); the editor then left. */
async function failedEdit(s: Stack, t: string) {
  const sock = s.connect('alice');
  await advance();
  expect(s.live()).toBeDefined();
  sock.deliver(s.editFrame(t));
  await advance();
  s.db.down = true;
  await advance(10_000); // the debounced store runs and fails
  expect(hasStoreFailure(s.live()!)).toBe(true);
  return sock;
}

const API_USER = { id: 'api', name: 'API' } as never;
const JSON_APPEND = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'from the API' }] }] };

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  for (const level of ['debug', 'warn', 'error', 'log'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resumeCompactionsForTests();
});

describe('#919 a failed store keeps its document in memory', () => {
  it('the editor leaves: the document stays resident; the store is retried with its author and contributors, then it unloads', async () => {
    const s = stack();
    const sock = await failedEdit(s, 'typed by alice');
    sock.close(1000, 'bye'); // the last connection: Hocuspocus asks to unload
    await advance();
    expect(s.hp.documents.has(DOC_NAME)).toBe(true); // kept: its edit is nowhere else
    expect(rowText(s.row.ydoc)).not.toContain('typed by alice');

    s.db.down = false;
    await advance(10_000); // the retry the kept document scheduled
    expect(rowText(s.row.ydoc)).toContain('typed by alice');
    const values = last(s.updatePage.mock.calls)[0];
    expect(values.lastUpdatedById).toBe('alice'); // the failed store's own payload: still her edit
    expect(values.contributorIds).toEqual(expect.arrayContaining(['earlier', 'alice'])); // restored after the failure
    expect(s.hp.documents.size).toBe(0); // stored, then unloaded as usual
  });

  it('MUTATION arm: without the unload veto the document (and her edit) leaves memory', async () => {
    jest.spyOn(keepFailedStore, 'keepFailedDocumentResident').mockImplementation(() => undefined);
    const s = stack();
    const sock = await failedEdit(s, 'typed by alice');
    sock.close(1000, 'bye');
    await advance();
    expect(s.hp.documents.size).toBe(0);
    s.db.down = false;
    await advance(60_000);
    expect(rowText(s.row.ydoc)).not.toContain('typed by alice'); // lost
  });

  it('the quiesce retries the failed store: while it fails it is reported, once it succeeds nothing is resident', async () => {
    const s = stack();
    await failedEdit(s, 'typed by alice');
    await expect(run(s.gateway.quiesce())).resolves.toEqual({ resident: 1, failed: [DOC_NAME] });
    s.db.down = false;
    await expect(run(s.gateway.quiesce())).resolves.toEqual({ resident: 0, failed: [] });
    expect(rowText(s.row.ydoc)).toContain('typed by alice');
    expect(last(s.updatePage.mock.calls)[0].lastUpdatedById).toBe('alice');
  });
});

describe('#919 while draining nothing loads, applies or writes', () => {
  it('a websocket (re)connect does not load the page; no direct write runs; a settle of a resident page fails closed', async () => {
    const s = stack();
    await expect(run(s.gateway.quiesce())).resolves.toEqual({ resident: 0, failed: [] });
    const reads = s.findById.mock.calls.length;

    const sock = s.connect('bob');
    await advance();
    expect(s.resident()).toBe(0);
    expect(s.findById.mock.calls.length).toBe(reads); // the row was never read: the load was refused first

    const append = { prosemirrorJson: JSON_APPEND, operation: 'append', user: API_USER };
    await expect(run(s.handlers.updatePageContent(DOC_NAME, append))).rejects.toBeInstanceOf(CollabQuiescedException);
    await expect(run(s.handlers.conditionalUpdatePageContent(DOC_NAME, append))).resolves.toEqual({ applied: false, reason: 'error' });
    const mark = { yjsSelection: { anchor: {}, head: {} } as never, commentId: 'c1', resolved: false, user: API_USER };
    await expect(run(s.handlers.setCommentMark(DOC_NAME, mark))).rejects.toBeInstanceOf(CollabQuiescedException);
    await expect(run(s.handlers.resolveCommentMark(DOC_NAME, { commentId: 'c1', resolved: true, user: API_USER }))).rejects.toBeInstanceOf(
      CollabQuiescedException,
    );
    await expect(run(s.handlers.flushPageContent(DOC_NAME))).resolves.toEqual({ flushed: false }); // nothing live: the row is the page
    expect(s.updatePage).not.toHaveBeenCalled();
    expect(s.resident()).toBe(0);
    expect(sock.closed).toBeNull(); // the socket itself is not torn down; it just holds nothing
  });

  it('control: outside a quiesce the same connect loads and the same direct write applies', async () => {
    const s = stack();
    s.connect('bob');
    await advance();
    expect(s.resident()).toBe(1);
    await run(s.handlers.updatePageContent(DOC_NAME, { prosemirrorJson: JSON_APPEND, operation: 'append', user: API_USER }));
    expect(rowText(s.row.ydoc)).toContain('from the API');
  });

  it('a socket opened before the quiesce and kept open: its later frames (queued before its re-auth too) and its reload are refused; the exit drain reports resident=0', async () => {
    const s = stack();
    const sock = await failedEdit(s, 'one'); // a document the quiesce must keep resident (its store fails)
    await expect(run(s.gateway.quiesce())).resolves.toEqual({ resident: 1, failed: [DOC_NAME] });
    expect(sock.closeReasons()).toContain('Reset Connection');
    expect(sock.closed).toBeNull(); // the ws stays open: it may authenticate the document again

    // the provider re-authenticates on the SAME socket and sends an edit queued behind the Auth
    const doc = s.live()!;
    const late = syncFrame(new RemoteClient(doc).edit(doc, paragraph('two')));
    sock.deliver(authFrame('alice'), late);
    await advance();
    expect(sock.closed).toEqual({ code: 1013, reason: COLLAB_PAGE_COMPACTING_REASON }); // refused by the frame hook
    expect(rowText(Y.encodeStateAsUpdate(s.live()!))).not.toContain('two'); // never applied, never acknowledged
    expect(
      sock.sent
        .map(readServerFrame)
        .filter((f) => f.type === MSG.SyncStatus),
    ).toHaveLength(1); // the one acknowledgement is the edit from before the quiesce

    // a fresh socket for the page: the document is resident, so its frames meet the frame hook too
    const other = s.connect('carol');
    other.deliver(late);
    await advance();
    expect(other.closed?.code).toBe(1013);

    // the process exits: the database is back, the drain's retry stores 'one', nothing stays resident
    s.db.down = false;
    await run(s.gateway.destroy({ close: jest.fn() } as never));
    expect(rowText(s.row.ydoc)).toContain('one');
    expect(rowText(s.row.ydoc)).not.toContain('two');
    expect(s.resident()).toBe(0);
    expect(last(s.drainLines)).toMatch(new RegExp(`^${COLLAB_DRAIN_TOKEN} done resident=0 failed=0 \\{"phase":"done","trigger":"shutdown"`));

    // a reload after the drain (the document is gone now) is refused before the row is read
    const reads = s.findById.mock.calls.length;
    s.connect('alice');
    await advance();
    expect(s.resident()).toBe(0);
    expect(s.findById.mock.calls.length).toBe(reads);
  });

  it('MUTATION arm: with the frame refusal removed, the edit queued behind the re-auth applies during the quiesce', async () => {
    const s = stack();
    const ext = (s.hp.configuration.extensions as Array<{ extensionName?: string; guard?: { refuseWhileDraining(f: unknown): void } }>).find(
      (e) => e.extensionName === 'CollabUpdateGuard',
    )!;
    jest.spyOn(ext.guard!, 'refuseWhileDraining').mockImplementation(() => undefined);
    const sock = await failedEdit(s, 'one');
    await run(s.gateway.quiesce());
    const doc = s.live()!;
    sock.deliver(authFrame('alice'), syncFrame(new RemoteClient(doc).edit(doc, paragraph('two'))));
    await advance();
    expect(rowText(Y.encodeStateAsUpdate(s.live()!))).toContain('two');
  });
});

describe('#919 the drain state', () => {
  it('cannot be lifted by another quiesce, a settle, a shutdown or time; only the abort lifts it, and then everything works again', async () => {
    const s = stack();
    await run(s.gateway.quiesce());
    await run(s.gateway.quiesce());
    await run(s.handlers.flushPageContent(DOC_NAME));
    await advance(5 * 60_000);
    expect(s.gateway.isQuiesced()).toBe(true);

    s.gateway.endQuiesce();
    expect(s.gateway.isQuiesced()).toBe(false);
    const sock = s.connect('bob');
    await advance();
    expect(s.resident()).toBe(1);
    sock.deliver(s.editFrame('after the abort'));
    await advance();
    await run(s.handlers.updatePageContent(DOC_NAME, { prosemirrorJson: JSON_APPEND, operation: 'append', user: API_USER }));
    expect(rowText(s.row.ydoc)).toContain('from the API');
    expect(rowText(s.row.ydoc)).toContain('after the abort');
    expect(sock.closed).toBeNull();
  });

  it('the shutdown and the route run the same drain: same stores, same counts, the same done line but for its trigger', async () => {
    const outcomes: Array<{ row: string; result: unknown; line: string }> = [];
    for (const trigger of ['quiesce', 'shutdown'] as const) {
      const s = stack();
      const sock = s.connect('alice');
      await advance();
      sock.deliver(s.editFrame('pending at the drain')); // debounced, not stored yet
      await advance(1_000);
      expect(rowText(s.row.ydoc)).not.toContain('pending at the drain');
      const result = await run<unknown>(trigger === 'quiesce' ? s.gateway.quiesce() : s.gateway.destroy({ close: jest.fn() } as never));
      outcomes.push({
        row: rowText(s.row.ydoc),
        result: trigger === 'quiesce' ? result : undefined,
        line: last(s.drainLines).replace(/"trigger":"\w+"/, '').replace(/"ms":\d+/, ''),
      });
      expect(s.bounds.draining).toBe(true);
      expect(s.resident()).toBe(0);
      expect(sock.closeReasons()).toContain('Reset Connection');
    }
    expect(outcomes[0].row).toBe(outcomes[1].row);
    expect(outcomes[0].row).toContain('pending at the drain');
    expect(outcomes[0].result).toEqual({ resident: 0, failed: [] });
    expect(outcomes[0].line).toBe(outcomes[1].line);
    expect(outcomes[0].line).toMatch(/^COLLAB_DRAIN done resident=0 failed=0 /);
  });

  it('a shutdown whose failed store never recovers ends at its budget and says so', async () => {
    const s = stack();
    await failedEdit(s, 'lost on exit');
    let ended = false;
    const exit = s.gateway.destroy({ close: jest.fn() } as never).then(() => (ended = true));
    await advance(SHUTDOWN_DRAIN_BUDGET_MS - 1_000);
    expect(ended).toBe(false); // still retrying
    await advance(2_000);
    await exit;
    expect(last(s.drainLines)).toMatch(/^COLLAB_DRAIN done resident=1 failed=1 /);
  });
});

describe('#919 superseded documents', () => {
  it("superseded by this process's own compaction: not a failure; it unloads and is not reported", async () => {
    const s = stack();
    s.connect('alice');
    await advance();
    markSuperseded(s.live()!, 2, 'compacted');
    recordStoreFailure(s.live()!); // a later store skips as superseded (compaction.ts skipStoreOfSuperseded)
    await expect(run(s.gateway.quiesce())).resolves.toEqual({ resident: 0, failed: [] });
  });

  it('superseded by a lineage move: what it holds can never be stored; kept and reported failed, never retried', async () => {
    const s = stack();
    s.connect('alice');
    await advance();
    markSuperseded(s.live()!, 2, 'lineage');
    recordStoreFailure(s.live()!, { documentName: DOC_NAME });
    const writes = s.updatePage.mock.calls.length;
    await expect(run(s.gateway.quiesce())).resolves.toEqual({ resident: 1, failed: [DOC_NAME] });
    expect(s.updatePage.mock.calls.length).toBe(writes);
  });
});
