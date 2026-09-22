import * as postgres from 'postgres';
import { ServiceUnavailableException } from '@nestjs/common';
import { ServiceBridgeService } from './service-bridge.service';
import { WorkspaceResolver } from './workspace-resolver';
import { shadowEmailFor } from './shadow-user';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  createReadModelTables,
  mkReadModelDb,
} from './read-model-pg.testkit';

/**
 * Issue #50 — the provisioning UPSERT against a REAL Postgres (the ticket's `INSERT … ON CONFLICT`
 * boundary). The unit spec (`service-bridge.service.spec.ts`) asserts the conflict callback's shape through
 * a Kysely double; it NEVER compiles or executes SQL, so it cannot prove:
 *   - the CamelCasePlugin column mapping in `onConflict(oc => oc.columns(['email','workspaceId']))` matches
 *     the real `users_email_workspace_id_unique` constraint (a mismatch here is a production 500 the fake
 *     can't see);
 *   - a planted REAL user is untouched (T-042);
 *   - a same-email row in a FOREIGN workspace is not matched, because the conflict target is
 *     `(email, workspace_id)` (T-043);
 *   - concurrent first-time provisions converge on ONE row under real ON CONFLICT semantics (T-044);
 *   - the no-workspace guard 503s before any write (T-045);
 *   - re-provisioning a soft-deleted shadow user does NOT resurrect it (T-046, RED — companion issue P5).
 *
 * Self-skips without AUTHZ_TEST_PG_URL (the `docmost-authz` lane); the `docmost-authz-pg` lane provides
 * Postgres and sets AUTHZ_REQUIRE_PG=1 so the anti-vacuity guard below reds if that wiring regresses.
 * Full case inventory: docs/test-plans/issue-50-docmost-bridge.md.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG provisioning lane', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'service_bridge_provision_pg_spec';
const DEFAULT_WS = uuid(100);
const FOREIGN_WS = uuid(200);

d('ServiceBridgeService.provisionShadowUser on real Postgres (no-takeover upsert, issue #50)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: any;
  let svc: ServiceBridgeService;

  /** Faithful to 20240324T085600-users.ts for the columns provisioning touches (incl. the unique key the
   *  ON CONFLICT target depends on). `gen_random_uuid()` stands in for the extension's `gen_uuid_v7()`. */
  const createUsersTable = async (p: postgres.Sql): Promise<void> => {
    await p`
      create table users (
        id uuid primary key default gen_random_uuid(),
        name varchar,
        email varchar not null,
        email_verified_at timestamptz,
        password varchar,
        role varchar,
        workspace_id uuid references workspaces(id) on delete cascade,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint users_email_workspace_id_unique unique (email, workspace_id)
      )`;
  };

  const countUsers = async (): Promise<number> => {
    const rows = (await pg`select count(*)::int as c from users`) as unknown as Array<{ c: number }>;
    return rows[0].c;
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    await createUsersTable(pg);

    const userRepo = {
      findByEmail: async (email: string, workspaceId: string) => {
        const rows = await pg`select * from users where email = ${email} and workspace_id = ${workspaceId} limit 1`;
        return rows[0];
      },
    } as any;
    const sessionService = { createSessionAndToken: async () => 'authtoken' } as any;
    // #455: provisioning tests never touch the session repo — a bare double keeps the constructor shape.
    const userSessionRepo = {} as any;
    svc = new ServiceBridgeService(
      db,
      userRepo,
      userSessionRepo,
      sessionService,
      new WorkspaceResolver(db),
    );
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 }).catch(() => undefined);
    await pg?.end({ timeout: 5 }).catch(() => undefined);
  });

  beforeEach(async () => {
    await pg`delete from users`;
    await pg`delete from workspaces`;
    await pg`insert into workspaces (id, name) values (${DEFAULT_WS}, 'default')`;
  });

  it('T-040: creates a plain verified MEMBER with the fork-derived synthetic email + hashed password', async () => {
    const res = await svc.provisionShadowUser({ externalId: 'alice' } as any);

    const rows = await pg`select * from users`;
    expect(rows).toHaveLength(1);
    const row = rows[0] as any;
    expect(row.id).toBe(res.userId);
    expect(res.workspaceId).toBe(DEFAULT_WS);
    expect(row.email).toBe(shadowEmailFor('alice'));
    expect(row.role).toBe('member'); // never elevated
    expect(row.email_verified_at).not.toBeNull();
    expect(row.deleted_at).toBeNull();
    expect(row.password).toMatch(/^\$/); // a real hash...
    expect(row.password).not.toContain('alice'); // ...never the input
  });

  it('T-041: the real ON CONFLICT upsert is idempotent — same id, one row', async () => {
    const first = await svc.provisionShadowUser({ externalId: 'alice' } as any);
    const second = await svc.provisionShadowUser({ externalId: 'alice' } as any);

    expect(second.userId).toBe(first.userId);
    expect(await countUsers()).toBe(1);
  });

  // The ticket's core no-takeover claim, on real SQL: a planted REAL user (normal email, elevated role)
  // cannot be matched by a derived shadow address — the upsert inserts a distinct shadow row and leaves the
  // victim byte-for-byte intact.
  it('T-042: a planted real user is untouched and gets no shadow takeover', async () => {
    const victimId = uuid(5);
    await pg`insert into users (id, name, email, password, role, workspace_id)
             values (${victimId}, 'Victim', 'victim@example.edu', 'VICTIM_HASH', 'owner', ${DEFAULT_WS})`;

    const res = await svc.provisionShadowUser({ externalId: 'victim' } as any);

    expect(res.userId).not.toBe(victimId);
    expect(await countUsers()).toBe(2);
    const rows = (await pg`select * from users where id = ${victimId}`) as unknown as Array<any>;
    expect(rows[0]).toMatchObject({
      email: 'victim@example.edu',
      role: 'owner',
      password: 'VICTIM_HASH',
    });
  });

  it('T-043: the conflict target includes workspace — a same-email row in a FOREIGN workspace is not matched', async () => {
    const foreignShadowId = uuid(6);
    const email = shadowEmailFor('alice');
    await pg`insert into workspaces (id, name) values (${FOREIGN_WS}, 'foreign')`;
    await pg`insert into users (id, email, password, role, workspace_id)
             values (${foreignShadowId}, ${email}, 'FOREIGN_HASH', 'member', ${FOREIGN_WS})`;

    const res = await svc.provisionShadowUser({ externalId: 'alice' } as any);

    expect(res.workspaceId).toBe(DEFAULT_WS);
    expect(res.userId).not.toBe(foreignShadowId);
    const rows = (await pg`select workspace_id from users where email = ${email}`) as unknown as Array<any>;
    expect(rows).toHaveLength(2); // one per workspace, no cross-workspace upsert
    const foreign = (await pg`select * from users where id = ${foreignShadowId}`) as unknown as Array<any>;
    expect(foreign[0].password).toBe('FOREIGN_HASH'); // untouched
  });

  it('T-044: concurrent first-time provisions converge on ONE row with the same id', async () => {
    const [a, b] = await Promise.all([
      svc.provisionShadowUser({ externalId: 'alice' } as any),
      svc.provisionShadowUser({ externalId: 'alice' } as any),
    ]);

    expect(a.userId).toBe(b.userId);
    expect(await countUsers()).toBe(1);
  });

  it('T-045: no workspace provisioned is a 503 BEFORE any write', async () => {
    await pg`delete from workspaces`;

    await expect(svc.provisionShadowUser({ externalId: 'alice' } as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await countUsers()).toBe(0);
  });

  /**
   * T-046 (companion issue P5 — FIXED). Provisioning is documented as idempotent. A shadow user that was
   * soft-deleted (offboarding / restore to a deleted state) must not stay `deleted_at != null` forever, or
   * mintSession refuses it and the identity can NEVER log into Docmost again. The conflict upsert now
   * resurrects the fork-owned row (`deleted_at = null`) against real ON CONFLICT semantics. (Was committed
   * red-on-purpose; the P5 fix flips it green.)
   */
  it('T-046: re-provisioning a soft-deleted shadow user resurrects it (deleted_at cleared)', async () => {
    const first = await svc.provisionShadowUser({ externalId: 'bob' } as any);
    await pg`update users set deleted_at = now() where id = ${first.userId}`;

    const second = await svc.provisionShadowUser({ externalId: 'bob' } as any);

    expect(second.userId).toBe(first.userId);
    const rows = (await pg`select * from users where id = ${first.userId}`) as unknown as Array<any>;
    expect(rows[0].deleted_at).toBeNull();
  });

  /**
   * T-047 (companion F3): the conflict upsert self-heals a TAMPERED/out-of-band-elevated shadow row back to
   * the "plain, live member" shape — role reset to `member` and `deleted_at` cleared — against real ON
   * CONFLICT semantics. Proves the de-escalation is a real UPDATE (the sibling `space_members` pattern),
   * not just a captured callback shape. `password` is deliberately left untouched by the upsert.
   */
  it('T-047 (F3): re-provisioning an out-of-band-elevated + deleted shadow row de-escalates and resurrects it', async () => {
    const first = await svc.provisionShadowUser({ externalId: 'carol' } as any);
    const before = (await pg`select password from users where id = ${first.userId}`) as unknown as Array<any>;
    await pg`update users set role = 'owner', deleted_at = now() where id = ${first.userId}`;

    const second = await svc.provisionShadowUser({ externalId: 'carol' } as any);

    expect(second.userId).toBe(first.userId);
    const rows = (await pg`select * from users where id = ${first.userId}`) as unknown as Array<any>;
    expect(rows[0].role).toBe('member'); // de-escalated (never re-elevated by a re-provision)
    expect(rows[0].deleted_at).toBeNull(); // resurrected
    expect(rows[0].password).toBe(before[0].password); // a credential swap never rides a re-provision
  });

  /**
   * T-048 (companion F2): case-variant `externalId`s must converge on ONE shadow row. The `(email,
   * workspace_id)` unique constraint is case-SENSITIVE and `findByEmail` matches case-INSENSITIVELY, so
   * without the case-normalizing derivation `Dave` and `dave` would insert TWO rows the lookup then resolves
   * ambiguously. With normalization the upsert matches and there is exactly one row.
   */
  it('T-048 (F2): case-variant externalIds converge on ONE shadow row (no duplicate/cross-map)', async () => {
    const a = await svc.provisionShadowUser({ externalId: 'Dave' } as any);
    const b = await svc.provisionShadowUser({ externalId: 'dave' } as any);

    expect(b.userId).toBe(a.userId);
    expect(await countUsers()).toBe(1);
    const rows = (await pg`select email from users`) as unknown as Array<any>;
    expect(rows[0].email).toBe(shadowEmailFor('Dave')); // the normalized (lower-cased) address
    expect(rows[0].email).toBe(shadowEmailFor('dave'));
  });
});
