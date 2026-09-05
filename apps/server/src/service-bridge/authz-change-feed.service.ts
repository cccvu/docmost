import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import * as postgres from 'postgres';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { normalizePostgresUrl } from '../common/helpers';
import { AUTHZ_MODE, AuthzMode } from '../authz/mode/authz-mode';
import { AuthzChangeEvent, mapOutboxRow, OutboxRow, isExpectedSkip } from './authz-change-event';

const NOTIFY_CHANNEL = 'authz_outbox';
const MAX_WAIT_MS = 25_000;
const MAX_LIMIT = 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000; // hourly retention sweep

const RETENTION_DAYS = (() => {
  const n = Number.parseInt(process.env.AUTHZ_OUTBOX_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();

/** The opaque change cursor: the inserting transaction id (xid8) and the outbox row id, the SOLE ordering +
 *  checkpoint primitive. `seq` (the bigserial) rides on events for diagnostics only. Serialized as
 *  "<xact_id>.<id>" (both are non-negative integers; xid8 does not wrap, so this is a permanent total order). */
interface Cursor {
  xactId: string;
  id: string;
}

/** The zero cursor (before every row): xid8 '0' sorts below every real transaction id (which start at 3). */
const ZERO_CURSOR = '0.0';

function parseCursor(raw: string | undefined): Cursor {
  if (!raw) return { xactId: '0', id: '0' };
  const m = /^(\d+)\.(\d+)$/.exec(raw);
  if (!m) throw new BadRequestException('invalid change cursor');
  return { xactId: m[1], id: m[2] };
}

function formatCursor(xactId: string, id: string): string {
  return `${xactId}.${id}`;
}

/** Tuple compare `a > b` on (xact_id, id), both as decimal strings (xid8 can exceed 2^53, so use BigInt). */
function tupleGt(a: Cursor, b: Cursor): boolean {
  const ax = BigInt(a.xactId);
  const bx = BigInt(b.xactId);
  if (ax !== bx) return ax > bx;
  return BigInt(a.id) > BigInt(b.id);
}

/** The outbox `payload` is read as TEXT (`payload::text`) on purpose (incident #181 follow-through). In the
 *  built image (plain node) postgres.js parses a stored `jsonb` column to an OBJECT and the application
 *  Kysely's CamelCasePlugin then camelCases its NESTED keys (workspace_id -> workspaceId), which silently
 *  defeated the snake_case mapper for every live event: spaces projected with a null workspace, members and
 *  pages dropped, while only the snapshot reconcile wrote tuples. (Under jest the same column arrived as a
 *  string, which is why the R2 real-Postgres spec never caught it.) A text column can be touched by no
 *  result-key plugin, so parsing it here yields exactly the snake_case keys the trigger stored, in every
 *  environment. Defensive: an object passes through unchanged, and an unparseable value degrades to `{}`
 *  (the mapper then yields null, and the reconciler backstops) rather than throwing and wedging the drain. */
function parsePayload(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export interface ChangesResult {
  events: AuthzChangeEvent[];
  /** The opaque cursor to pass as `after` next time (advances past SKIPPED/null-mapping rows too, so a
   *  skipped row never re-delivers). Unchanged from `after` when no safe row existed after it. */
  nextCursor: string;
  /** The current SAFE frontier: the max committed-and-settled `(xact_id, id)`. Diagnostic (lag/caught-up). */
  head: string;
  /** Age in ms of the OLDEST safe row still pending after `nextCursor` (null when caught up). Feeds the
   *  platform's oldest-unconsumed-age alarm without the platform ever querying Docmost. */
  oldestPendingAgeMs: number | null;
}

/** Thrown when the requested cursor is at/below the retention high-water mark (events were GC'd past the
 *  consumer). The controller maps this to 409 so the platform REBASELINES (reconcile + reset cursor to the
 *  snapshot baseline), never silently skips. `head` is the current safe frontier cursor. */
export class StaleCursorError extends Error {
  constructor(readonly head: string) {
    super('cursor is older than the oldest retained change; rebaseline required');
    this.name = 'StaleCursorError';
  }
}

/**
 * CCC service-bridge — NOT upstream Docmost code (Group D, issue #171).
 *
 * Serves the authz change feed the platform drains to project membership/page/restriction changes into
 * SpiceDB. THE DURABLE OUTBOX TABLE IS THE SOURCE OF TRUTH: every request reads from the table; LISTEN/NOTIFY
 * is WAKEUP-ONLY (it only resolves a blocked long-poll early), so a missed NOTIFY or a dropped LISTEN adds
 * only LATENCY (the platform also runs an unconditional backstop poll). The internal LISTEN is best-effort
 * (postgres.js auto-reconnects); if it can't be established the feed degrades to poll latency, not an outage.
 *
 * COMMIT-SAFE, GAP-FREE DELIVERY (R2, issue #171): the read is gated by
 * `xact_id < pg_snapshot_xmin(pg_current_snapshot())` and ordered/cursored by `(xact_id, id)`. A row is served
 * ONLY once its inserting transaction (and every older one) is fully settled, so the classic transactional-
 * outbox commit-ordering skip (a lower bigserial that commits after the consumer passed a higher one) is
 * impossible: the cursor advances in transaction-id order, never in bigserial order. `xid8` is the non-wrapping
 * 64-bit FullTransactionId, so the cursor is a permanent total order. See the plan's proof; the real-PG
 * two-connection concurrency test proves it on the engine.
 *
 * `getChanges` long-polls: if nothing is available it waits up to `waitMs` for a NOTIFY (or the timeout), then
 * reads once more. Stale-cursor detection guards future outbox retention: the retention sweep records the max
 * `(xact_id, id)` it ever deletes into `authz_outbox_gc`; a cursor at/below that mark means an un-consumed row
 * was GC'd, so the feed throws (409) and the platform rebaselines rather than skipping the gap.
 */
@Injectable()
export class AuthzChangeFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthzChangeFeedService.name);
  private listenSql: postgres.Sql | null = null;
  private listenHandle: { unlisten: () => Promise<void> } | null = null;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly env: EnvironmentService,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.mode !== 'remote') return; // no feed consumer in native
    await this.startListen();
    this.gcTimer = setInterval(() => void this.gc(), GC_INTERVAL_MS);
    this.gcTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.wakeAll(); // release any blocked long-polls
    try {
      await this.listenHandle?.unlisten();
    } catch {
      /* best-effort */
    }
    try {
      await this.listenSql?.end({ timeout: 5 });
    } catch {
      /* best-effort */
    }
  }

  /** A dedicated postgres.js connection for LISTEN (postgres.js auto-reconnects + re-subscribes). Best-effort:
   *  a failure here degrades the feed to poll latency, it does NOT fail the boot (the outbox table is the
   *  source of truth; the installer already fail-closed on the table itself). */
  private async startListen(): Promise<void> {
    try {
      this.listenSql = postgres(normalizePostgresUrl(this.env.getDatabaseURL()), {
        max: 1,
        onnotice: () => {},
      });
      this.listenHandle = await this.listenSql.listen(NOTIFY_CHANNEL, () => this.wakeAll());
      this.logger.log(`authz change feed listening on channel ${NOTIFY_CHANNEL}`);
    } catch (e) {
      this.logger.warn(
        `authz change feed LISTEN unavailable — falling back to poll latency (backstop covers correctness): ${(e as Error).message}`,
      );
    }
  }

  private wakeAll(): void {
    const woken = [...this.waiters];
    this.waiters.clear();
    for (const w of woken) w();
  }

  private waitForWake(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.waiters.delete(wake);
        clearTimeout(timer);
        resolve();
      };
      const wake = (): void => finish();
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      this.waiters.add(wake);
    });
  }

  /** Long-poll for changes after the opaque `after` cursor. */
  async getChanges(after: string | undefined, waitMs: number, limit: number): Promise<ChangesResult> {
    const cursor = parseCursor(after);
    const cappedWait = Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
    const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));

    const head = await this.head();
    await this.assertNotStale(cursor, head);

    let raw = await this.readRawAfter(cursor, cappedLimit);
    if (raw.length === 0 && cappedWait > 0) {
      await this.waitForWake(cappedWait);
      raw = await this.readRawAfter(cursor, cappedLimit);
    }

    const events: AuthzChangeEvent[] = [];
    const dropped: string[] = [];
    for (const r of raw) {
      const ev = mapOutboxRow(r.row);
      if (ev) events.push(ev);
      else if (!isExpectedSkip(r.row)) dropped.push(`${r.row.tableName}:id=${r.row.id}:op=${r.row.op}`);
    }
    if (dropped.length > 0) {
      // DETECTOR for the incident #181 class (a key-shape mismatch silently dropped every live event for a release):
      // a row from a table the mapper knows that still maps to nothing is a defect, never a routine skip. The cursor
      // still advances (below) so the feed cannot wedge; the reconciler is the backstop. Greppable marker.
      this.logger.warn(
        `AUTHZ_CHANGE_EVENT_DROPPED count=${dropped.length} rows=[${dropped.join(',')}] a known authz table row did not map to an event (payload shape or mapper defect); the cursor advances past it and the reconciler is the backstop`,
      );
    }
    // Advance past every RAW safe row read (including null-mapping/skipped rows), so a skipped row never
    // re-delivers. Unchanged from `after` when nothing safe followed it.
    const last = raw.length ? raw[raw.length - 1] : null;
    const nextCursor = last ? formatCursor(last.xactId, last.id) : formatCursor(cursor.xactId, cursor.id);
    const oldestPendingAgeMs = await this.oldestPendingAgeMs(parseCursor(nextCursor));
    return { events, nextCursor, head, oldestPendingAgeMs };
  }

  private async readRawAfter(
    cursor: Cursor,
    limit: number,
  ): Promise<{ row: OutboxRow; xactId: string; id: string }[]> {
    const res = await sql<{
      id: string;
      op: string;
      tableName: string;
      payloadJson: string;
      xactId: string;
    }>`
      select id, op, table_name, payload::text as payload_json, xact_id
      from authz_outbox
      where (xact_id, id) > (${cursor.xactId}::xid8, ${cursor.id}::bigint)
        and xact_id < pg_snapshot_xmin(pg_current_snapshot())
      order by xact_id asc, id asc
      limit ${limit}
    `.execute(this.db);
    return res.rows.map((r) => ({
      row: {
        id: Number(r.id),
        op: r.op as OutboxRow['op'],
        tableName: r.tableName,
        payload: parsePayload(r.payloadJson),
      },
      xactId: String(r.xactId),
      id: String(r.id),
    }));
  }

  /** The current SAFE frontier as an opaque cursor: the max committed-and-settled `(xact_id, id)`, or the zero
   *  cursor when nothing is settled/pending. Diagnostic (and the head carried on a stale 409). */
  async head(): Promise<string> {
    const res = await sql<{ xactId: string; id: string }>`
      select xact_id, id from authz_outbox
      where xact_id < pg_snapshot_xmin(pg_current_snapshot())
      order by xact_id desc, id desc limit 1
    `.execute(this.db);
    const row = res.rows[0];
    return row ? formatCursor(String(row.xactId), String(row.id)) : ZERO_CURSOR;
  }

  /** Age (ms) of the HEAD-OF-LINE safe row still pending after `cursor` (the next to be delivered), or null
   *  when caught up. An index-ordered `limit 1` seek on the `(xact_id, id)` index (O(log n)) rather than a
   *  `min(created_at)` aggregate scan over the pending tail — so a bulk burst drained one-per-poll stays
   *  O(M log n), not O(M^2). Head-of-line age is also the truer "drainer stuck" signal than min-age. */
  private async oldestPendingAgeMs(cursor: Cursor): Promise<number | null> {
    const res = await sql<{ ageMs: number }>`
      select extract(epoch from (now() - created_at)) * 1000 as age_ms
      from authz_outbox
      where (xact_id, id) > (${cursor.xactId}::xid8, ${cursor.id}::bigint)
        and xact_id < pg_snapshot_xmin(pg_current_snapshot())
      order by xact_id asc, id asc
      limit 1
    `.execute(this.db);
    const age = res.rows[0]?.ageMs;
    return age == null ? null : Math.round(Number(age));
  }

  /** Throw StaleCursorError if `cursor` is at/below the retention high-water mark (an un-consumed row was GC'd).
   *  Precise: `authz_outbox_gc` holds the MAX `(xact_id, id)` ever deleted; if the consumer has not passed it,
   *  a GC'd row lies after its cursor and is lost -> rebaseline. This is correct even under commit reordering
   *  (a min(created_at)/min(id) heuristic could miss a late-committing higher-xid row GC'd early). */
  private async assertNotStale(cursor: Cursor, head: string): Promise<void> {
    const res = await sql<{ stale: boolean }>`
      select (g.xact_id, g.id) > (${cursor.xactId}::xid8, ${cursor.id}::bigint) as stale
      from authz_outbox_gc g
      where g.singleton = true
    `.execute(this.db);
    if (res.rows[0]?.stale) throw new StaleCursorError(head);
  }

  /** Retention sweep. Deletes rows older than the window and advances the GC high-water mark to the max
   *  `(xact_id, id)` removed (monotonic), so stale detection stays correct as retention reclaims the table. */
  private async gc(): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        const del = await sql<{ xactId: string; id: string }>`
          delete from authz_outbox
          where created_at < now() - ${sql.raw(`interval '${RETENTION_DAYS} days'`)}
          returning xact_id, id
        `.execute(trx);
        if (del.rows.length === 0) return;
        let mx: Cursor = { xactId: String(del.rows[0].xactId), id: String(del.rows[0].id) };
        for (const r of del.rows) {
          const c: Cursor = { xactId: String(r.xactId), id: String(r.id) };
          if (tupleGt(c, mx)) mx = c;
        }
        await sql`
          update authz_outbox_gc
          set xact_id = ${mx.xactId}::xid8, id = ${mx.id}::bigint
          where (xact_id, id) < (${mx.xactId}::xid8, ${mx.id}::bigint)
        `.execute(trx);
        this.logger.log(
          `authz_outbox retention sweep removed ${del.rows.length} rows older than ${RETENTION_DAYS}d (gc mark -> ${mx.xactId}.${mx.id})`,
        );
      });
    } catch (e) {
      this.logger.warn(`authz_outbox retention sweep failed (will retry): ${(e as Error).message}`);
    }
  }
}
