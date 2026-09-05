import { AuthzChangeFeedService, StaleCursorError } from './authz-change-feed.service';
import { BadRequestException } from '@nestjs/common';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

/**
 * The change-feed read/stale/cursor logic (Group D R2, #171). The durable outbox is the source of truth and
 * delivery is COMMIT-SAFE: the read is gated by `xact_id < pg_snapshot_xmin` and ordered/cursored by the
 * opaque `(xact_id, id)` token, so a lower bigserial that commits late can never be skipped (the real-PG
 * two-connection proof is in authz-outbox-commit-safety.pg.spec.ts). These offline specs pin the cursor
 * mechanics: opaque cursor round-trip, advance-past-skipped rows, the gc-watermark stale 409, and that the
 * event `seq` stays diagnostic (never the cursor).
 */
function feed(respond: (q: SpyQuery) => unknown[]) {
  const spy = spyKysely(respond);
  const svc = new AuthzChangeFeedService(spy.db, {} as any, 'remote' as any);
  return { svc, spy };
}

/** Route the four read queries getChanges issues to canned rows. Keys are snake_case (the CamelCasePlugin
 *  camelCases them on the way out, exactly as a real Postgres result would). */
const responder =
  (opts: {
    head?: { xact_id: string; id: string } | null;
    stale?: boolean;
    oldestAgeMs?: number | null;
    rows?: unknown[];
  }) =>
  (q: SpyQuery): unknown[] => {
    if (q.sql.includes('authz_outbox_gc')) return [{ stale: opts.stale ?? false }];
    if (q.sql.includes('age_ms')) return [{ age_ms: opts.oldestAgeMs ?? null }];
    if (q.sql.includes('order by xact_id desc')) return opts.head ? [opts.head] : [];
    if (q.sql.includes('from authz_outbox')) return opts.rows ?? [];
    return [];
  };

// The feed reads `payload::text as payload_json` (a STRING), so the spy answers `payload_json` as a string
// (the spy's CamelCasePlugin maps the column NAME to payloadJson and never touches the keys inside a string).
// This mirrors production: the driver parses a jsonb column to an object and the plugin would camelCase its
// nested keys, which is exactly why the feed never reads the jsonb column directly (incident #181).
const memberRow = (id: number, xactId: string) => ({
  id,
  op: 'INSERT',
  table_name: 'space_members',
  payload_json: JSON.stringify({ space_id: 's1', user_id: 'u1', group_id: null, role: 'reader' }),
  xact_id: xactId,
});

describe('AuthzChangeFeedService (R2 commit-safe cursor)', () => {
  it('reads the outbox payload as TEXT so no result-key plugin can rewrite its keys (incident #181)', async () => {
    // In production postgres.js parses jsonb to an OBJECT and the app Kysely's CamelCasePlugin camelCases the
    // NESTED keys (workspace_id -> workspaceId), which silently defeated the snake_case mapper for every live
    // event (the reconcile path masked it). Reading `payload::text` is the mechanism that makes the key case
    // independent of the driver and of any plugin; this pins it at the SQL level.
    const seen: string[] = [];
    const { svc } = feed((q) => {
      seen.push(q.sql);
      return responder({ head: { xact_id: '50', id: '7' }, rows: [memberRow(6, '50')] })(q);
    });
    await svc.getChanges('0.0', 0, 500);
    const read = seen.find((q) => q.includes('from authz_outbox') && q.includes('order by xact_id asc'));
    expect(read).toBeDefined();
    expect(read).toMatch(/payload::text as payload_json/);
  });

  it('head() returns the SAFE frontier as an opaque (xact_id.id) cursor', async () => {
    const { svc } = feed(responder({ head: { xact_id: '100', id: '5' } }));
    expect(await svc.head()).toBe('100.5');
  });

  it('head() is the zero cursor when nothing is settled/pending', async () => {
    const { svc } = feed(responder({ head: null }));
    expect(await svc.head()).toBe('0.0');
  });

  it('throws StaleCursorError when the cursor is at/below the gc high-water mark', async () => {
    const { svc } = feed(responder({ head: { xact_id: '100', id: '5' }, stale: true }));
    await expect(svc.getChanges('3.1', 0, 500)).rejects.toBeInstanceOf(StaleCursorError);
  });

  it('the stale error carries the current safe frontier as head', async () => {
    const { svc } = feed(responder({ head: { xact_id: '100', id: '5' }, stale: true }));
    await svc.getChanges('3.1', 0, 500).catch((e) => {
      expect(e).toBeInstanceOf(StaleCursorError);
      expect((e as StaleCursorError).head).toBe('100.5');
    });
  });

  it('does NOT throw when the cursor has passed the gc high-water mark', async () => {
    const { svc } = feed(responder({ head: { xact_id: '100', id: '5' }, stale: false, rows: [] }));
    await expect(svc.getChanges('99.9', 0, 500)).resolves.toBeDefined();
  });

  it('rejects a malformed cursor with 400', async () => {
    const { svc } = feed(responder({ head: null }));
    await expect(svc.getChanges('not-a-cursor', 0, 500)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps rows to events and advances nextCursor PAST skipped (null-mapping) rows', async () => {
    const rows = [
      memberRow(6, '50'),
      { id: 7, op: 'INSERT', table_name: 'users', payload: JSON.stringify({ id: 'u9' }), xact_id: '50' }, // unknown table -> skip
    ];
    const { svc } = feed(responder({ head: { xact_id: '50', id: '7' }, rows, oldestAgeMs: null }));
    const res = await svc.getChanges('49.0', 0, 500);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'SpaceMemberChanged', seq: 6 });
    expect(res.nextCursor).toBe('50.7'); // advanced past the skipped id 7, in (xact_id, id) space
  });

  it('warns AUTHZ_CHANGE_EVENT_DROPPED when a KNOWN authz table row does not map (defect detector, incident #181) and stays silent for unknown tables', async () => {
    // The second #181 defect (every live event dropped by a key-shape mismatch) survived a whole release because a
    // null mapping was silent. A row from a table the mapper KNOWS that still maps to null is a mapper/payload
    // defect and must leave a greppable marker; rows from tables the mapper ignores stay a silent skip.
    const rows = [
      memberRow(6, '50'),
      { id: 7, op: 'INSERT', table_name: 'space_members', payload_json: JSON.stringify({ user_id: 'u1', role: 'reader' }), xact_id: '50' }, // known table, no space_id -> null
      { id: 8, op: 'INSERT', table_name: 'users', payload_json: JSON.stringify({ id: 'u9' }), xact_id: '50' }, // unknown table -> silent skip
    ];
    const { svc } = feed(responder({ head: { xact_id: '50', id: '8' }, rows, oldestAgeMs: null }));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    const res = await svc.getChanges('49.0', 0, 500);
    expect(res.events).toHaveLength(1);
    expect(res.nextCursor).toBe('50.8'); // the cursor still advances past the dropped row (the reconciler is the backstop)
    const dropped = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('AUTHZ_CHANGE_EVENT_DROPPED'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('space_members');
    expect(dropped[0]).toContain('id=7');
    expect(dropped[0]).not.toContain('users');
  });

  it('surfaces oldestPendingAgeMs from the feed (fork-provided, no platform DB query)', async () => {
    const { svc } = feed(responder({ head: { xact_id: '50', id: '7' }, rows: [memberRow(6, '50')], oldestAgeMs: 4200 }));
    const res = await svc.getChanges('49.0', 0, 500);
    expect(res.oldestPendingAgeMs).toBe(4200);
  });

  it('returns empty (cursor unchanged) after a long-poll timeout with no rows', async () => {
    const { svc } = feed(responder({ head: { xact_id: '10', id: '5' }, rows: [], oldestAgeMs: null }));
    const res = await svc.getChanges('10.5', 5, 500); // wait 5ms, nothing arrives
    expect(res.events).toEqual([]);
    expect(res.nextCursor).toBe('10.5');
    expect(res.oldestPendingAgeMs).toBeNull();
  });

  it('long-poll returns promptly on a NOTIFY wake (not only on timeout)', async () => {
    let rows: unknown[] = [];
    const spy = spyKysely((q: SpyQuery) => {
      if (q.sql.includes('authz_outbox_gc')) return [{ stale: false }];
      if (q.sql.includes('age_ms')) return [{ age_ms: null }];
      if (q.sql.includes('order by xact_id desc')) return [{ xact_id: '50', id: '6' }];
      if (q.sql.includes('from authz_outbox')) return rows;
      return [];
    });
    const svc = new AuthzChangeFeedService(spy.db, {} as any, 'remote' as any);
    const p = svc.getChanges('49.0', 10_000, 500); // 10s wait; must NOT actually wait that long
    for (let i = 0; i < 200 && (svc as any).waiters.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    rows = [memberRow(6, '50')];
    (svc as unknown as { wakeAll(): void }).wakeAll();
    const res = await p;
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'SpaceMemberChanged', seq: 6 });
    expect(res.nextCursor).toBe('50.6');
  });
});
