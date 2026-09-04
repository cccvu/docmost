import {
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
import { AuthzChangeEvent, mapOutboxRow, OutboxRow } from './authz-change-event';

const NOTIFY_CHANNEL = 'authz_outbox';
const MAX_WAIT_MS = 25_000;
const MAX_LIMIT = 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000; // hourly retention sweep

const RETENTION_DAYS = (() => {
  const n = Number.parseInt(process.env.AUTHZ_OUTBOX_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();

export interface ChangesResult {
  events: AuthzChangeEvent[];
  /** The cursor to pass as `after` next time (advances past SKIPPED rows too, so a null-mapping row never
   *  re-delivers forever). Unchanged from `after` when no row existed after it. */
  nextCursor: number;
  /** The current feed head (max outbox seq). The platform baselines its cursor to this on first boot. */
  head: number;
}

/** Thrown when the requested `after` precedes the oldest retained row (events were GC'd past the consumer).
 *  The controller maps this to 409 so the platform REBASELINES (reconcile + reset cursor=head), never
 *  silently skips. */
export class StaleCursorError extends Error {
  constructor(readonly head: number) {
    super('cursor is older than the oldest retained change; rebaseline required');
    this.name = 'StaleCursorError';
  }
}

/**
 * CCC service-bridge — NOT upstream Docmost code (Group D, issue #171).
 *
 * Serves the authz change feed the platform drains to project membership/page/restriction changes into
 * SpiceDB. THE DURABLE OUTBOX TABLE IS THE SOURCE OF TRUTH: every request reads `where id > :after order by
 * id` from the table; LISTEN/NOTIFY is WAKEUP-ONLY (it only resolves a blocked long-poll early). A missed
 * NOTIFY or a dropped LISTEN can therefore only add latency, never lose an event — the platform also runs an
 * unconditional backstop poll. The internal LISTEN is best-effort (postgres.js auto-reconnects); if it can't
 * be established the feed degrades to poll latency, not an outage.
 *
 * `getChanges` long-polls: if nothing is available it waits up to `waitMs` for a NOTIFY (or the timeout), then
 * reads once more. Stale-cursor detection guards future outbox retention: if `after` precedes the oldest
 * retained row it throws (409) so the platform rebaselines rather than skipping the GC'd gap.
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

  /** Long-poll for changes after `after`. */
  async getChanges(afterRaw: number, waitMs: number, limit: number): Promise<ChangesResult> {
    const after = Math.max(0, Math.trunc(afterRaw));
    const cappedWait = Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
    const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));

    const head = await this.head();
    await this.assertNotStale(after, head);

    let raw = await this.readRawAfter(after, cappedLimit);
    if (raw.length === 0 && cappedWait > 0) {
      await this.waitForWake(cappedWait);
      raw = await this.readRawAfter(after, cappedLimit);
    }

    const events: AuthzChangeEvent[] = [];
    for (const r of raw) {
      const ev = mapOutboxRow(r);
      if (ev) events.push(ev);
    }
    // Advance past every RAW row read (including null-mapping/skipped rows), so a skipped row never re-delivers.
    const nextCursor = raw.length ? raw[raw.length - 1].id : after;
    return { events, nextCursor, head: Math.max(head, nextCursor) };
  }

  private async readRawAfter(after: number, limit: number): Promise<OutboxRow[]> {
    const res = await sql<{ id: number; op: string; tableName: string; payload: Record<string, unknown> }>`
      select id, op, table_name, payload
      from authz_outbox
      where id > ${after}
      order by id asc
      limit ${limit}
    `.execute(this.db);
    return res.rows.map((r) => ({
      id: Number(r.id),
      op: r.op as OutboxRow['op'],
      tableName: r.tableName,
      payload: r.payload,
    }));
  }

  /** The current feed head from the outbox sequence (monotonic, survives retention GC of the rows). */
  async head(): Promise<number> {
    const res = await sql<{ lastValue: number; isCalled: boolean }>`
      select last_value, is_called from authz_outbox_id_seq
    `.execute(this.db);
    const row = res.rows[0];
    if (!row || !row.isCalled) return 0;
    return Number(row.lastValue);
  }

  /** Throw StaleCursorError if events after `after` have already been GC'd (a retention gap). */
  private async assertNotStale(after: number, head: number): Promise<void> {
    const res = await sql<{ oldest: number | null }>`select min(id) as oldest from authz_outbox`.execute(this.db);
    const oldest = res.rows[0]?.oldest;
    const firstNeeded = after + 1;
    if (oldest == null) {
      // Empty table: everything up to head has been consumed or GC'd. Stale only if the consumer is behind head.
      if (after < head) throw new StaleCursorError(head);
      return;
    }
    if (Number(oldest) > firstNeeded) {
      // A gap: rows firstNeeded..oldest-1 were GC'd before this consumer read them.
      throw new StaleCursorError(head);
    }
  }

  /** Retention sweep. Bounded by age; the platform keeps up in ~ms so this never races the consumer. */
  private async gc(): Promise<void> {
    try {
      const res = await sql<{ id: string }>`
        delete from authz_outbox
        where created_at < now() - ${sql.raw(`interval '${RETENTION_DAYS} days'`)}
        returning id
      `.execute(this.db);
      if (res.rows.length > 0) {
        this.logger.log(`authz_outbox retention sweep removed ${res.rows.length} rows older than ${RETENTION_DAYS}d`);
      }
    } catch (e) {
      this.logger.warn(`authz_outbox retention sweep failed (will retry): ${(e as Error).message}`);
    }
  }
}
