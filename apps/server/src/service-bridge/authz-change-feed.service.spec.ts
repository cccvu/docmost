import { AuthzChangeFeedService, StaleCursorError } from './authz-change-feed.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

/**
 * The change-feed read/stale/cursor logic (Group D, #171). The durable outbox is the source of truth: these
 * pin that the cursor advances past SKIPPED rows (so a null-mapping row never re-delivers), that a stale
 * cursor throws (so the platform rebaselines instead of skipping a GC'd gap), and that head comes from the
 * monotonic sequence (survives retention GC).
 */
function feed(respond: (q: SpyQuery) => unknown[]) {
  const spy = spyKysely(respond);
  const svc = new AuthzChangeFeedService(spy.db, {} as any, 'remote' as any);
  return { svc, spy };
}

/** Route the three read queries getChanges issues to canned rows. */
const responder =
  (opts: { head: number; oldest: number | null; rows: unknown[] }) =>
  (q: SpyQuery): unknown[] => {
    if (q.sql.includes('authz_outbox_id_seq')) return [{ last_value: opts.head, is_called: opts.head > 0 }];
    if (q.sql.includes('min(id)')) return [{ oldest: opts.oldest }];
    if (q.sql.includes('from authz_outbox') && q.sql.includes('id >')) return opts.rows;
    return [];
  };

describe('AuthzChangeFeedService', () => {
  it('head() reads the monotonic sequence (survives GC of the rows)', async () => {
    const { svc } = feed(responder({ head: 100, oldest: null, rows: [] }));
    expect(await svc.head()).toBe(100);
  });

  it('throws StaleCursorError when the cursor precedes the oldest retained row', async () => {
    // oldest=5 means rows 1..4 were GC'd; a consumer at after=0 would skip them -> rebaseline required.
    const { svc } = feed(responder({ head: 100, oldest: 5, rows: [] }));
    await expect(svc.getChanges(0, 0, 500)).rejects.toBeInstanceOf(StaleCursorError);
  });

  it('does NOT treat after == oldest-1 as stale (contiguous)', async () => {
    const { svc } = feed(responder({ head: 100, oldest: 5, rows: [] }));
    // after=4 -> firstNeeded=5 == oldest -> contiguous, not stale.
    await expect(svc.getChanges(4, 0, 500)).resolves.toBeDefined();
  });

  it('maps rows to events and advances nextCursor PAST skipped (null-mapping) rows', async () => {
    const rows = [
      { id: 6, op: 'INSERT', table_name: 'space_members', payload: { space_id: 's1', user_id: 'u1', group_id: null, role: 'reader' } },
      { id: 7, op: 'INSERT', table_name: 'users', payload: { id: 'u9' } }, // unknown table -> skipped, but cursor must pass it
    ];
    const { svc } = feed(responder({ head: 7, oldest: 1, rows }));
    const res = await svc.getChanges(5, 0, 500);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'SpaceMemberChanged', seq: 6 });
    expect(res.nextCursor).toBe(7); // advanced past the skipped id 7
  });

  it('returns empty (cursor unchanged) after a long-poll timeout with no rows', async () => {
    const { svc } = feed(responder({ head: 10, oldest: 1, rows: [] }));
    const res = await svc.getChanges(10, 5, 500); // wait 5ms, nothing arrives
    expect(res.events).toEqual([]);
    expect(res.nextCursor).toBe(10);
  });

  it('empty outbox: a cursor behind head is stale (rebaseline required)', async () => {
    // All rows GC'd (min(id) null) but head has advanced -> a consumer behind head must rebaseline, not skip.
    const { svc } = feed(responder({ head: 10, oldest: null, rows: [] }));
    await expect(svc.getChanges(5, 0, 500)).rejects.toBeInstanceOf(StaleCursorError);
  });

  it('empty outbox: a cursor AT head resolves empty (not stale)', async () => {
    const { svc } = feed(responder({ head: 10, oldest: null, rows: [] }));
    const res = await svc.getChanges(10, 0, 500);
    expect(res.events).toEqual([]);
    expect(res.nextCursor).toBe(10);
  });

  it('long-poll returns promptly on a NOTIFY wake (not only on timeout)', async () => {
    // Prove the wakeup path: a change that lands mid-wait + a wake resolves the poll before its (large) timeout.
    let rows: unknown[] = [];
    const spy = spyKysely((q: SpyQuery) => {
      if (q.sql.includes('authz_outbox_id_seq')) return [{ last_value: 10, is_called: true }];
      if (q.sql.includes('min(id)')) return [{ oldest: 1 }];
      if (q.sql.includes('from authz_outbox') && q.sql.includes('id >')) return rows;
      return [];
    });
    const svc = new AuthzChangeFeedService(spy.db, {} as any, 'remote' as any);
    const p = svc.getChanges(5, 10_000, 500); // 10s wait; must NOT actually wait that long
    // Wait for the long-poll to register its waiter (after the initial empty read).
    for (let i = 0; i < 200 && (svc as any).waiters.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    rows = [{ id: 6, op: 'INSERT', table_name: 'space_members', payload: { space_id: 's1', user_id: 'u1', group_id: null, role: 'reader' } }];
    (svc as unknown as { wakeAll(): void }).wakeAll();
    const res = await p;
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'SpaceMemberChanged', seq: 6 });
    expect(res.nextCursor).toBe(6);
  });
});
