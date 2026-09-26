import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { ServiceSpaceService } from './service-space.service';
import { ServiceBridgeService } from './service-bridge.service';
import { AuthzOutboxInstaller } from './authz-outbox.installer';
import { shadowEmailFor } from './shadow-user';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from './read-model-pg.testkit';
import { IdempotencyLedgerInstaller } from '../authz/idempotency/idempotency-ledger.installer';
import {
  IdempotencyLedgerService,
  namespaceDigest,
  servicePrincipal,
  sha256hex,
} from '../authz/idempotency/idempotency-ledger.service';

/**
 * #616 Stage 3 — the KEYED space create (`POST /api/service/spaces` with `idempotencyKey`) on real Postgres, through
 * the real ServiceSpaceService, the real shadow-user provisioning, the real ledger and the real authz outbox trigger:
 *   - the same key twice → ONE space and ONE creator-admin row; the retry is `replayed: true` with the same id and
 *     re-runs nothing (no space / member / outbox row; the shadow-user upsert leaves the same single user row);
 *   - the same key concurrently → ONE space, both answers carry its id; a call arriving while a twin holds the key
 *     WAITS (observed in pg_locks) and replays what the twin committed;
 *   - the same key with a different fingerprint → 409 `idempotency_key_reused`;
 *   - a keyed create that rolls back (slug taken by another space) leaves no ledger row: the key is free again;
 *   - a cross-actor or cross-credential replay is impossible: another human (or the same human through another
 *     service credential) sending the same key, namespace and fingerprint never gets this space;
 *   - a twin held past lock_timeout → 503 `engine_busy`, nothing created;
 *   - unkeyed is unchanged (friendly slug pre-check, no `replayed` in the body).
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG keyed space create gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'service_space_idempotent_create_pg_spec';
const WS = uuid(100);
const CRED = 'shared';
const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

d('ServiceSpaceService keyed create on real Postgres (#616)', () => {
  jest.setTimeout(30_000); // provisioning bcrypt-hashes an unusable password per call

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceSpaceService;

  const body = (over: Record<string, unknown> = {}) =>
    ({
      name: 'Engineering',
      creatorExternalId: 'ext-alice',
      idempotencyKey: 'key-1',
      idempotencyNamespace: 'user:ext-alice',
      fingerprint: FP,
      ...over,
    }) as never;
  const counts = async () => {
    const [r] = await pg<{ spaces: number; members: number; users: number; ledger: number; outbox: number }[]>`
      select (select count(*)::int from spaces) as spaces, (select count(*)::int from space_members) as members,
             (select count(*)::int from users) as users, (select count(*)::int from ccc_idempotency_ledger) as ledger,
             (select count(*)::int from authz_outbox) as outbox`;
    return r;
  };
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      (r) => `${(r as { replayed?: boolean }).replayed ? 'replayed' : 'created'}:${(r as { id: string }).id}`,
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? (e.getResponse() as { message?: string }).message ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );
  const shadowId = async (externalId: string) =>
    (await pg<{ id: string }[]>`select id from users where email = ${shadowEmailFor(externalId)}`)[0]?.id;
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 200; i++) {
      const [{ c }] = await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no session ever waited on a lock');
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 3);
    appPg = mkReadModelPg(SCHEMA, 6);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    // What the read-model testkit omits (faithful to 20240324T085900-spaces.ts / 20240324T085600-users.ts).
    await pg`alter table spaces alter column id set default gen_random_uuid()`;
    await pg`alter table spaces add constraint spaces_slug_workspace_id_unique unique (slug, workspace_id)`;
    await pg`alter table space_members add constraint space_members_space_id_user_id_unique unique (space_id, user_id)`;
    await pg`
      create table users (
        id uuid primary key default gen_random_uuid(), name varchar, email varchar not null,
        email_verified_at timestamptz, password varchar, avatar_url varchar, role varchar, workspace_id uuid,
        locale varchar, timezone varchar, settings jsonb, last_login_at timestamptz, deactivated_at timestamptz,
        has_generated_password boolean default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint users_email_workspace_id_unique unique (email, workspace_id)
      )`;
    await pg`create table group_users (id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null)`;
    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new IdempotencyLedgerInstaller(db as never, 'remote').install();

    const resolver = fakeWorkspaceResolver(WS);
    const bridge = new ServiceBridgeService(db as any, new UserRepo(db as any), {} as any, {} as any, resolver, {} as any);
    svc = new ServiceSpaceService(db as any, resolver, bridge, new IdempotencyLedgerService());
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    await pg`delete from ccc_idempotency_ledger`;
    await pg`delete from space_members`;
    await pg`delete from spaces`;
    await pg`delete from users`;
    await pg`delete from authz_outbox`;
  });

  it('the same key twice: ONE space and ONE admin row; the retry replays its id and re-runs nothing', async () => {
    const first = await svc.create(body(), CRED);
    expect(first).toEqual({ id: expect.any(String), slug: 'engineering', name: 'Engineering', replayed: false });
    const alice = await shadowId('ext-alice');
    const after = await counts();
    expect(after).toEqual({ spaces: 1, members: 1, users: 1, ledger: 1, outbox: 2 }); // space + member rows

    const again = await svc.create(body(), CRED);
    expect(again).toEqual({ ...first, replayed: true });
    // Nothing re-ran: no space, member, ledger or outbox row; the shadow upsert touched the same single user.
    expect(await counts()).toEqual(after);
    expect(await shadowId('ext-alice')).toBe(alice);
    const [m] = await pg<{ userId: string; role: string }[]>`select user_id as "userId", role from space_members`;
    expect(m).toEqual({ userId: alice, role: 'admin' });
    const [row] = await pg<{ resourceId: string }[]>`select resource_id as "resourceId" from ccc_idempotency_ledger`;
    expect(row.resourceId).toBe(first.id);
  });

  it('the same key concurrently: ONE space, both answers carry its id', async () => {
    const results = await Promise.all([0, 1].map(() => outcome(svc.create(body(), CRED))));
    const spaces = await pg<{ id: string }[]>`select id from spaces`;
    expect(spaces).toHaveLength(1);
    expect(results.sort()).toEqual([`created:${spaces[0].id}`, `replayed:${spaces[0].id}`]);
    expect((await counts()).members).toBe(1);
  });

  it('a call arriving while a twin holds the key WAITS, then replays what the twin committed', async () => {
    await svc.create(body({ idempotencyKey: 'warm-up', name: 'Warm up' }), CRED); // provisions alice
    const alice = (await shadowId('ext-alice')) as string;
    const twinSpace = uuid(7);
    const side = await appPg.reserve();
    let pending!: Promise<string>;
    try {
      await side`begin`;
      await side`insert into spaces (id, name, slug, creator_id, workspace_id) values (${twinSpace}, 'Engineering', 'engineering', ${alice}, ${WS})`;
      await side`insert into ccc_idempotency_ledger (namespace_digest, op, key_digest, fingerprint, resource_id)
                 values (${namespaceDigest({ workspaceId: WS, principal: servicePrincipal(CRED, alice), namespace: 'user:ext-alice' })},
                         'space.create', ${sha256hex('key-1')}, ${FP}, ${twinSpace})`;
      pending = outcome(svc.create(body(), CRED));
      await waitForLockWaiter();
      await side`commit`;
    } finally {
      side.release();
    }
    expect(await pending).toBe(`replayed:${twinSpace}`);
    expect(await pg`select id from spaces where slug = 'engineering'`).toHaveLength(1);
  });

  it('the same key with a different fingerprint → 409 idempotency_key_reused, nothing created', async () => {
    await svc.create(body(), CRED);
    const before = await counts();
    expect(await outcome(svc.create(body({ name: 'Other', fingerprint: FP2 }), CRED))).toBe('409:idempotency_key_reused');
    expect(await counts()).toEqual(before);
  });

  it('a keyed create that rolls back leaves no ledger row (slug held by another space): the key is free again', async () => {
    await svc.create(body({ idempotencyKey: undefined, idempotencyNamespace: undefined, fingerprint: undefined }), CRED);
    expect(await outcome(svc.create(body({ idempotencyKey: 'key-2' }), CRED))).toBe(
      '409:a space with the slug "engineering" already exists',
    );
    expect((await counts()).ledger).toBe(0);
    await pg`delete from space_members`;
    await pg`delete from spaces`;
    expect(await outcome(svc.create(body({ idempotencyKey: 'key-2' }), CRED))).toMatch(/^created:/);
  });

  it('a cross-actor or cross-credential replay is impossible: never answered with this space', async () => {
    const alices = await svc.create(body({ slug: 'alice-space' }), CRED);
    // Bob sends EXACTLY alice's request (same key, namespace string, fingerprint and body): a separate entry, so he is
    // never handed alice's space — his own create collides on the slug (409) and rolls back.
    expect(await outcome(svc.create(body({ creatorExternalId: 'ext-bob', slug: 'alice-space' }), CRED))).toBe(
      '409:a space with the slug "alice-space" already exists',
    );
    // With his own slug the same key creates HIS space.
    const bobs = await svc.create(body({ creatorExternalId: 'ext-bob', slug: 'bob-space' }), CRED);
    expect(bobs.replayed).toBe(false);
    expect(bobs.id).not.toBe(alices.id);
    // Alice through another service credential: a separate entry too.
    expect(await outcome(svc.create(body({ slug: 'alice-space' }), 'other-credential'))).toBe(
      '409:a space with the slug "alice-space" already exists',
    );
    const [{ creator }] = await pg<{ creator: string }[]>`select creator_id as creator from spaces where id = ${bobs.id}`;
    expect(creator).toBe(await shadowId('ext-bob'));
    expect(await svc.create(body({ slug: 'alice-space' }), CRED)).toEqual({ ...alices, replayed: true });
  });

  it('a twin held past lock_timeout → 503 engine_busy, nothing created', async () => {
    await svc.create(body({ idempotencyKey: 'warm-up', name: 'Warm up' }), CRED);
    const alice = (await shadowId('ext-alice')) as string;
    const side = await appPg.reserve();
    try {
      await side`begin`;
      await side`insert into ccc_idempotency_ledger (namespace_digest, op, key_digest, fingerprint)
                 values (${namespaceDigest({ workspaceId: WS, principal: servicePrincipal(CRED, alice), namespace: 'user:ext-alice' })},
                         'space.create', ${sha256hex('key-1')}, ${FP})`;
      expect(await outcome(svc.create(body(), CRED))).toBe('503:engine_busy');
    } finally {
      await side`rollback`;
      side.release();
    }
    expect(await pg`select id from spaces where slug = 'engineering'`).toHaveLength(0);
  });

  it('replays an archived space as it is (the platform decides what to do with it)', async () => {
    const first = await svc.create(body(), CRED);
    await pg`update spaces set deleted_at = now() where id = ${first.id}`;
    expect(await svc.create(body(), CRED)).toEqual({ ...first, replayed: true });
  });

  it('unkeyed is unchanged: the friendly slug pre-check, no ledger row, no `replayed` in the body', async () => {
    const unkeyed = body({ idempotencyKey: undefined, idempotencyNamespace: undefined, fingerprint: undefined });
    const created = await svc.create(unkeyed);
    expect(Object.keys(created).sort()).toEqual(['id', 'name', 'slug']);
    expect((await counts()).ledger).toBe(0);
    expect(await outcome(svc.create(unkeyed))).toBe('409:a space with the slug "engineering" already exists');
  });
});
