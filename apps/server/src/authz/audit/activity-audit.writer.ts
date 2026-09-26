import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { ClsService } from 'nestjs-cls';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AuditContext, AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogContext, NoopAuditService } from '../../integrations/audit/audit.service';
import { ActorType, AuditEvent, AuditLogPayload, AuditResource } from '../../common/events/audit-events';

/**
 * CCC activity persistence — NOT upstream Docmost code (wiki-v2 #615).
 *
 * WHAT: a handful of page/comment LIFECYCLE events — trash, restore, move to another space, comment delete,
 * resolve and reopen — are written into Docmost's own `audit` table (upstream migration
 * `20260228T223532-audit`), so the service-bridge activity feed (`POST /api/service/content/activity/list`) can
 * list them next to the create/edit/comment/upload history the engine's state tables already hold. Those six
 * leave no other trace in the fork: a trashed page is just a `deleted_at`, a resolved comment a `resolved_at`,
 * and nothing records WHO did it or WHEN it was undone.
 *
 * WHY this table: it is upstream's own event log (uuidv7 ids, a `(workspace_id, id desc)` index), and in this
 * build nothing else writes or reads it — upstream's writer is the EE audit module, which we never load — so
 * reusing it needs no DDL. It is NOT an audit trail here: the platform's hash-chained central audit stays the
 * tamper-evident source of truth (every event is still forwarded there, with its network evidence).
 *
 * WHAT IS NEVER STORED: the client IP (`ip_address` is always NULL — the platform records the resolved
 * address; a second, unvalidated copy here would be a worse answer to the same question), the user agent,
 * `changes`, and any payload metadata other than a comment's `pageId` — so no page title, space name or
 * Docmost-internal detail lands in a table the feed reads. A row missing a fact it needs (no workspace, a
 * non-uuid resource or page id) is SKIPPED, never guessed.
 *
 * FAILURE POSTURE: fire-and-forget. `record()` never throws and never rejects; a failed insert is logged and
 * dropped. The loss is a gap in a product feed, not in the audit record, and must never fail the user's
 * request that emitted it.
 *
 * RETENTION: an hourly, bounded prune removes allowlisted rows older than the workspace's
 * `audit_retention_days` (default 365). It deletes ONLY the allowlisted events it wrote, in small batches with
 * a per-run cap, so a backlog drains over several hours instead of one long delete.
 */

/** event -> the resource type its emitter sends. Both must match, so an unexpected emitter shape is skipped. */
const ACTIVITY_EVENT_RESOURCE: ReadonlyMap<string, string> = new Map<string, string>([
  [AuditEvent.PAGE_TRASHED, AuditResource.PAGE], // page.controller.ts delete (soft)
  [AuditEvent.PAGE_RESTORED, AuditResource.PAGE], // page.controller.ts restore
  [AuditEvent.PAGE_MOVED_TO_SPACE, AuditResource.PAGE], // page.controller.ts move-to-space
  [AuditEvent.COMMENT_DELETED, AuditResource.COMMENT], // comment.controller.ts delete (pageId in changes.before)
  [AuditEvent.COMMENT_RESOLVED, AuditResource.COMMENT], // authz/comment-resolution (pageId in metadata)
  [AuditEvent.COMMENT_REOPENED, AuditResource.COMMENT], // authz/comment-resolution (pageId in metadata)
]);

/** The events this writer persists (and the only ones its prune ever deletes). */
export const ACTIVITY_AUDIT_EVENTS: readonly string[] = Object.freeze([...ACTIVITY_EVENT_RESOURCE.keys()]);

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
/** Upper clamp on a configured retention: keeps `make_interval(days => …)` inside int4 (100 years ≈ forever). */
const MAX_AUDIT_RETENTION_DAYS = 36500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly, like the authz outbox retention sweep
export const PRUNE_BATCH_SIZE = 500;
/** Per workspace per run: at most PRUNE_BATCH_SIZE × this rows (5,000/hour) — a backlog drains, never spikes. */
export const PRUNE_MAX_BATCHES_PER_WORKSPACE = 10;
/** Rows per INSERT for a batch-context call (an import batch carries no allowlisted event today). */
const INSERT_CHUNK = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES: ReadonlySet<string> = new Set<ActorType>(['user', 'system', 'api_key']);

const asUuid = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/** The actor half of an audit context — the only part a row takes. Structurally satisfied by AuditLogContext. */
export interface ActivityAuditContext {
  workspaceId?: string | null;
  actorId?: string | null;
  actorType?: string | null;
}

/**
 * One `audit` row, exactly the columns this writer sets. `ip_address` and `changes` are deliberately absent
 * from the type, so they can never be supplied (both are NULL in every row); `id` / `created_at` take the
 * table defaults (uuidv7, now()).
 */
export interface ActivityAuditRow {
  workspaceId: string;
  actorId: string | null;
  actorType: ActorType;
  event: string;
  resourceType: string;
  resourceId: string;
  spaceId: string | null;
  metadata: { pageId: string } | null;
}

/**
 * Map one upstream payload onto an activity row, or `null` to skip it (not allowlisted, or missing a fact the
 * feed needs). Pure — the allowlist and every skip rule are pinned in activity-audit.writer.spec.ts.
 *
 * A comment event's page comes from `metadata.pageId` (the fork's resolve/reopen) or, failing that,
 * `changes.before.pageId` (upstream's comment delete) — the feed reads `metadata->>'pageId'` either way.
 */
export function toActivityAuditRow(
  payload: AuditLogPayload,
  context: ActivityAuditContext | undefined,
): ActivityAuditRow | null {
  const expectedResource = ACTIVITY_EVENT_RESOURCE.get(payload?.event);
  if (!expectedResource || payload.resourceType !== expectedResource) return null;

  const workspaceId = asUuid(context?.workspaceId);
  if (!workspaceId) return null; // never guess the tenant
  const resourceId = asUuid(payload.resourceId);
  if (!resourceId) return null;

  let metadata: ActivityAuditRow['metadata'] = null;
  if (expectedResource === AuditResource.COMMENT) {
    const pageId = asUuid(payload.metadata?.pageId ?? payload.changes?.before?.pageId);
    if (!pageId) return null; // a comment event the feed cannot place on a page is useless to it
    metadata = { pageId };
  }

  return {
    workspaceId,
    actorId: asUuid(context?.actorId),
    actorType: ACTOR_TYPES.has(context?.actorType as string) ? (context.actorType as ActorType) : 'user',
    event: payload.event,
    resourceType: expectedResource,
    resourceId,
    spaceId: asUuid(payload.spaceId),
    metadata,
  };
}

/** A retention value from `workspaces.audit_retention_days` (nullable int8), defaulted and clamped. */
export function auditRetentionDays(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.min(n, MAX_AUDIT_RETENTION_DAYS);
}

/** The ambient (CLS) audit context of the request in scope, or undefined outside one. */
export function ambientActivityContext(cls: ClsService): ActivityAuditContext | undefined {
  const ctx = cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
  if (!ctx) return undefined;
  return { workspaceId: ctx.workspaceId, actorId: ctx.actorId, actorType: ctx.actorType };
}

@Injectable()
export class ActivityAuditWriter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityAuditWriter.name);
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private pruning = false;

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  onModuleInit(): void {
    // Unref'd, so the sweep never holds the process open on shutdown; the in-flight flag in pruneExpired()
    // keeps a slow run from overlapping the next tick, so a node prunes at most once an hour.
    this.pruneTimer = setInterval(() => void this.pruneExpired(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  /**
   * Persist the allowlisted subset of `payloads`. Never throws and never rejects — callers `void` it. The rows
   * are built synchronously, before the first await, so the context is the caller's at call time.
   */
  async record(payloads: readonly AuditLogPayload[], context: ActivityAuditContext | undefined): Promise<void> {
    let rows: ActivityAuditRow[];
    try {
      rows = [];
      for (const payload of payloads) {
        const row = toActivityAuditRow(payload, context);
        if (row) rows.push(row);
      }
    } catch (e) {
      this.logger.warn(`activity audit rows could not be built (dropped): ${(e as Error)?.message}`);
      return;
    }
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      try {
        await this.db.insertInto('audit').values(chunk).execute();
      } catch (e) {
        this.logger.warn(
          `activity audit write failed (dropped ${chunk.length} row(s), events=${[...new Set(chunk.map((r) => r.event))].join(',')}): ${(e as Error)?.message}`,
        );
      }
    }
  }

  /**
   * One bounded retention pass over every workspace; returns the rows removed. Never rejects. Public for the
   * pg spec — production runs it only from the hourly timer.
   *
   * `for update skip locked` lets two fork nodes sweep at once without blocking each other; `order by id`
   * (uuidv7, time-ordered) takes the oldest first, so a capped run still removes the right rows.
   */
  async pruneExpired(): Promise<number> {
    if (this.pruning) return 0;
    this.pruning = true;
    let removed = 0;
    try {
      const workspaces = await this.db.selectFrom('workspaces').select(['id', 'auditRetentionDays']).execute();
      for (const ws of workspaces) {
        try {
          removed += await this.pruneWorkspace(ws.id, auditRetentionDays(ws.auditRetentionDays));
        } catch (e) {
          this.logger.warn(`activity audit retention prune failed for workspace ${ws.id} (retries next hour): ${(e as Error)?.message}`);
        }
      }
      if (removed > 0) this.logger.log(`activity audit retention prune removed ${removed} row(s)`);
    } catch (e) {
      this.logger.warn(`activity audit retention prune failed (retries next hour): ${(e as Error)?.message}`);
    } finally {
      this.pruning = false;
    }
    return removed;
  }

  private async pruneWorkspace(workspaceId: string, retentionDays: number): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES_PER_WORKSPACE; batch++) {
      const res = await sql`
        delete from audit
        where id in (
          select id from audit
          where workspace_id = ${workspaceId}::uuid
            and event = any(${[...ACTIVITY_AUDIT_EVENTS]}::text[])
            and created_at < now() - make_interval(days => ${retentionDays}::int)
          order by id
          limit ${PRUNE_BATCH_SIZE}
          for update skip locked
        )
      `.execute(this.db);
      const n = Number(res.numAffectedRows ?? 0);
      removed += n;
      if (n < PRUNE_BATCH_SIZE) break;
    }
    return removed;
  }
}

/**
 * The standalone (`AUTHZ_MODE=native`) `AUDIT_SERVICE`: upstream's no-op — standalone has no central sink to
 * forward to — plus the same activity persistence as the remote binding, so the fork's `audit` rows mean the
 * same thing in either mode and a deployment switched to remote has no lifecycle gap. `setActorId` /
 * `setActorType` stay no-ops (stock native behaviour): the in-request actor comes from the global
 * `AuditActorInterceptor`, and none of the allowlisted events is emitted from a login flow.
 */
export class StandaloneAuditService extends NoopAuditService {
  constructor(
    private readonly cls: ClsService,
    private readonly activity: ActivityAuditWriter,
  ) {
    super();
  }

  override log(payload: AuditLogPayload): void {
    this.recordActivity([payload], () => ambientActivityContext(this.cls));
  }

  override logWithContext(payload: AuditLogPayload, context: AuditLogContext): void {
    this.recordActivity([payload], () => context);
  }

  override logBatchWithContext(payloads: AuditLogPayload[], context: AuditLogContext): void {
    this.recordActivity(payloads, () => context);
  }

  private recordActivity(payloads: readonly AuditLogPayload[], context: () => ActivityAuditContext | undefined): void {
    try {
      void this.activity.record(payloads, context()).catch(() => undefined);
    } catch {
      // record() never throws by contract; this only keeps a broken writer off the request path.
    }
  }
}
