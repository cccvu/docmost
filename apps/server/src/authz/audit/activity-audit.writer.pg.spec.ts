import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogPayload } from '../../common/events/audit-events';
import { up as createUuidV7Fn } from '../../database/migrations/20240324T085400-uuid_v7_fn';
import { up as createAuditTable } from '../../database/migrations/20260228T223532-audit';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
} from '../../service-bridge/read-model-pg.testkit';
import {
  ActivityAuditWriter,
  PRUNE_BATCH_SIZE,
  PRUNE_MAX_BATCHES_PER_WORKSPACE,
  StandaloneAuditService,
} from './activity-audit.writer';
import { PlatformAuditService } from './platform-audit.service';

/**
 * CCC activity persistence (#615) on real Postgres, over Docmost's REAL `audit` DDL (the upstream
 * `uuid_v7_fn` + `audit` migrations run against a minimal `workspaces` table):
 *  - an allowlisted event logged through the real `PlatformAuditService` (remote) or `StandaloneAuditService`
 *    (native) lands as exactly one row with the expected columns — uuidv7 id, actor, resource, space,
 *    `metadata = {pageId}` for comment events (readable as `metadata->>'pageId'`, the feed's access path) — and
 *    `ip_address` / `changes` are NULL even though the context carried an IP and the payload carried changes;
 *  - a non-allowlisted or unplaceable event writes nothing, and a failed insert neither rejects nor stops the
 *    forward;
 *  - the retention prune honours each workspace's `audit_retention_days` (default 365), deletes ONLY the
 *    allowlisted events, is capped per run (PRUNE_BATCH_SIZE × PRUNE_MAX_BATCHES_PER_WORKSPACE) and drains the
 *    rest on the next run, and two nodes pruning at once neither block nor double-count (skip locked).
 *
 * Self-skips without AUTHZ_TEST_PG_URL (the `docmost-authz-pg` CI job provides Postgres); owns a private schema.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG activity audit gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'activity_audit_pg_spec';
const WS = uuid(100);
const WS_SHORT = uuid(200); // audit_retention_days = 30
const ACTOR = uuid(900);
const PAGE = uuid(10);
const SPACE = uuid(1);
const COMMENT = uuid(20);

const ctx = { workspaceId: WS, actorId: ACTOR, actorType: 'user' as const, ipAddress: '203.0.113.9', userAgent: 'jest' };

d('ActivityAuditWriter on real Postgres (#615)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let writer: ActivityAuditWriter;
  let warnSpy: jest.SpyInstance;

  const rows = () =>
    pg<Record<string, unknown>[]>`
      select id::text as id, workspace_id::text as workspace_id, actor_id::text as actor_id, actor_type, event,
             resource_type, resource_id::text as resource_id, space_id::text as space_id, changes, metadata,
             metadata->>'pageId' as meta_page_id, host(ip_address) as ip, created_at
      from audit order by id`;

  /** Insert `n` rows straight into `audit`, `ageDays` old (the writer only ever writes "now"). */
  const seed = (n: number, opts: { ws?: string; event?: string; ageDays: number }) =>
    pg`
      insert into audit (workspace_id, actor_id, event, resource_type, resource_id, created_at)
      select ${opts.ws ?? WS}::uuid, ${ACTOR}::uuid, ${opts.event ?? 'page.trashed'}, 'page', gen_random_uuid(),
             now() - make_interval(days => ${opts.ageDays}::int)
      from generate_series(1, ${n}::int)`;
  const count = async (where = pg`true`) => {
    const [r] = await pg<{ n: number }[]>`select count(*)::int as n from audit where ${where}`;
    return r.n;
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await pg`create table workspaces (id uuid primary key, deleted_at timestamptz)`;
    // The REAL upstream DDL: gen_uuid_v7(), the audit table + its index, workspaces.audit_retention_days.
    await createUuidV7Fn(db);
    await createAuditTable(db);
    await pg`insert into workspaces (id) values (${WS})`;
    await pg`insert into workspaces (id, audit_retention_days) values (${WS_SHORT}, 30)`;
    writer = new ActivityAuditWriter(db as any);
  });

  beforeEach(() => {
    warnSpy = jest.spyOn((writer as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await pg`delete from audit`;
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  /** Log through the real service and wait for the fire-and-forget insert it started. */
  const viaPlatformService = async (log: (svc: PlatformAuditService) => void) => {
    const cls = { get: (key: unknown) => (key === AUDIT_CONTEXT_KEY ? { ...ctx } : undefined), set: () => undefined };
    const client = { forward: jest.fn(async (_events: unknown[]) => undefined) };
    const record = jest.spyOn(writer, 'record');
    try {
      log(new PlatformAuditService(cls as never, client as never, writer));
      await Promise.all(record.mock.results.map((r) => r.value));
    } finally {
      record.mockRestore();
    }
    return client;
  };

  describe('what lands', () => {
    it('a page event logged in-request becomes one row with the expected columns, and NO ip or changes', async () => {
      const client = await viaPlatformService((svc) =>
        svc.log({
          event: 'page.moved_to_space',
          resourceType: 'page',
          resourceId: PAGE,
          spaceId: SPACE,
          changes: { before: { spaceId: SPACE }, after: { spaceId: uuid(2) } },
          metadata: { title: 'Quarterly plan', childPageIds: [uuid(11)] },
        } as AuditLogPayload),
      );

      const [row, ...rest] = await rows();
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        workspace_id: WS,
        actor_id: ACTOR,
        actor_type: 'user',
        event: 'page.moved_to_space',
        resource_type: 'page',
        resource_id: PAGE,
        space_id: SPACE,
        changes: null,
        metadata: null,
        ip: null,
      });
      expect(String(row.id)[14]).toBe('7'); // the table default: gen_uuid_v7(), so the feed's keyset is time-ordered
      expect(Date.now() - new Date(row.created_at as string).getTime()).toBeLessThan(60_000);
      // The platform still receives the IP — only the local copy drops it.
      expect(client.forward.mock.calls[0][0][0]).toMatchObject({ ipAddress: '203.0.113.9' });
    });

    it('comment events carry {pageId} from either emitter shape, readable as metadata->>pageId', async () => {
      await viaPlatformService((svc) => {
        svc.log({
          event: 'comment.resolved',
          resourceType: 'comment',
          resourceId: COMMENT,
          spaceId: SPACE,
          metadata: { pageId: PAGE, note: 'dropped' },
        } as AuditLogPayload);
        svc.log({
          event: 'comment.deleted',
          resourceType: 'comment',
          resourceId: uuid(21),
          spaceId: SPACE,
          changes: { before: { pageId: PAGE, creatorId: ACTOR } },
        } as AuditLogPayload);
      });

      const got = await rows();
      expect(got.map((r) => [r.event, r.resource_id, r.metadata, r.meta_page_id, r.changes, r.ip])).toEqual(
        expect.arrayContaining([
          ['comment.resolved', COMMENT, { pageId: PAGE }, PAGE, null, null],
          ['comment.deleted', uuid(21), { pageId: PAGE }, PAGE, null, null],
        ]),
      );
      expect(got).toHaveLength(2);
    });

    it('a batch writes only its allowlisted, placeable rows', async () => {
      await viaPlatformService((svc) =>
        svc.logBatchWithContext(
          [
            { event: 'page.created', resourceType: 'page', resourceId: uuid(30) },
            { event: 'page.deleted', resourceType: 'page', resourceId: uuid(31) },
            { event: 'page.trashed', resourceType: 'page', resourceId: uuid(32), spaceId: SPACE },
            { event: 'page.restored', resourceType: 'page', resourceId: 'not-a-uuid' },
            { event: 'comment.reopened', resourceType: 'comment', resourceId: uuid(33) }, // no pageId anywhere
            { event: 'comment.reopened', resourceType: 'comment', resourceId: uuid(34), metadata: { pageId: PAGE } },
          ] as AuditLogPayload[],
          { workspaceId: WS, actorType: 'system', ipAddress: '198.51.100.1' },
        ),
      );
      const got = await rows();
      expect(got.map((r) => [r.event, r.resource_id, r.actor_id, r.actor_type, r.ip])).toEqual(
        expect.arrayContaining([
          ['page.trashed', uuid(32), null, 'system', null],
          ['comment.reopened', uuid(34), null, 'system', null],
        ]),
      );
      expect(got).toHaveLength(2);
    });

    it('a context without a workspace writes nothing (the tenant is never guessed)', async () => {
      await writer.record([{ event: 'page.trashed', resourceType: 'page', resourceId: PAGE } as AuditLogPayload], {
        actorId: ACTOR,
      });
      expect(await count()).toBe(0);
    });

    it('the native binding (StandaloneAuditService) lands the same row', async () => {
      const cls = { get: (key: unknown) => (key === AUDIT_CONTEXT_KEY ? { ...ctx } : undefined) };
      const record = jest.spyOn(writer, 'record');
      try {
        new StandaloneAuditService(cls as never, writer).log({
          event: 'page.restored',
          resourceType: 'page',
          resourceId: PAGE,
          spaceId: SPACE,
        } as AuditLogPayload);
        await Promise.all(record.mock.results.map((r) => r.value));
      } finally {
        record.mockRestore();
      }
      const got = await rows();
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ event: 'page.restored', workspace_id: WS, actor_id: ACTOR, ip: null });
    });

    it('a failed insert (unknown workspace) neither rejects nor stops the forward, and is logged', async () => {
      const ghost = uuid(999);
      const cls = {
        get: (key: unknown) => (key === AUDIT_CONTEXT_KEY ? { ...ctx, workspaceId: ghost } : undefined),
        set: () => undefined,
      };
      const client = { forward: jest.fn(async (_events: unknown[]) => undefined) };
      const record = jest.spyOn(writer, 'record');
      try {
        const svc = new PlatformAuditService(cls as never, client as never, writer);
        expect(() =>
          svc.log({ event: 'page.trashed', resourceType: 'page', resourceId: PAGE } as AuditLogPayload),
        ).not.toThrow();
        await expect(record.mock.results[0].value).resolves.toBeUndefined();
      } finally {
        record.mockRestore();
      }
      expect(client.forward).toHaveBeenCalledTimes(1);
      expect(await count()).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('activity audit write failed');
    });
  });

  describe('retention prune', () => {
    it('honours each workspace retention (default 365) and deletes ONLY the allowlisted events', async () => {
      await seed(3, { ws: WS, ageDays: 400 }); // past the 365-day default → removed
      await seed(2, { ws: WS, ageDays: 100 }); // inside the default → kept
      await seed(4, { ws: WS_SHORT, ageDays: 31, event: 'comment.deleted' }); // past its 30 days → removed
      await seed(1, { ws: WS_SHORT, ageDays: 29 }); // inside its 30 days → kept
      await seed(2, { ws: WS, ageDays: 400, event: 'user.login' }); // not ours → NEVER deleted, however old
      await seed(1, { ws: WS_SHORT, ageDays: 400, event: 'page.created' }); // not ours → kept

      expect(await writer.pruneExpired()).toBe(7);
      expect(await count(pg`workspace_id = ${WS} and event = 'page.trashed'`)).toBe(2);
      expect(await count(pg`workspace_id = ${WS_SHORT} and event = 'page.trashed'`)).toBe(1);
      expect(await count(pg`workspace_id = ${WS_SHORT} and event = 'comment.deleted'`)).toBe(0);
      expect(await count(pg`event in ('user.login', 'page.created')`)).toBe(3);
      // Idempotent: nothing left to remove.
      expect(await writer.pruneExpired()).toBe(0);
    });

    it('is bounded per run and drains the remainder on the next run, oldest first', async () => {
      const cap = PRUNE_BATCH_SIZE * PRUNE_MAX_BATCHES_PER_WORKSPACE;
      await seed(cap + 7, { ws: WS, ageDays: 500 });
      await seed(5, { ws: WS, ageDays: 1 }); // live rows, never touched

      expect(await writer.pruneExpired()).toBe(cap);
      expect(await count()).toBe(7 + 5);
      expect(await writer.pruneExpired()).toBe(7);
      expect(await count()).toBe(5);
    });

    it('two nodes pruning at once neither block each other nor double-count', async () => {
      await seed(PRUNE_BATCH_SIZE * 3 + 11, { ws: WS, ageDays: 500 });
      const other = new ActivityAuditWriter(db as any);
      const [a, b] = await Promise.all([writer.pruneExpired(), other.pruneExpired()]);
      expect(a + b).toBe(PRUNE_BATCH_SIZE * 3 + 11);
      expect(await count()).toBe(0);
    });
  });
});
