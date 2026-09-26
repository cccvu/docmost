import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { ServiceSpaceService } from './service-space.service';
import { ServiceBridgeService } from './service-bridge.service';
import { ServiceContentService } from './service-content.service';
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

/**
 * #616 Stage 2 on real Postgres: the space and membership versions, their atomic compares, and the member preview.
 *   - the version a read issues (`content/spaces/:id` — the `/v1` space GET —, `spaces/:id`, the member list) is the
 *     one the write compares; stale → 412 with the row AND the outbox unchanged; fresh → applied, answering the next
 *     read's version; `*` = exists;
 *   - two writes holding the same version race under the row lock: exactly one applies;
 *   - the compare comes before rule M and the last-admin guard (a stale version is a 412, never a 403 / 409);
 *   - a compared write bounds its wait (503 engine_busy after lock_timeout); an uncompared one still waits as before;
 *   - the member preview decides like the write and writes NOTHING: no users row (never provisions), no
 *     space_members row, no outbox row.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG versioned space + member gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'service_space_versioned_pg_spec';
const WS = uuid(100);
const S = uuid(1);

d('ServiceSpaceService versions + previews on real Postgres (#616)', () => {
  jest.setTimeout(60_000);

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceSpaceService;
  let content: ServiceContentService;

  const shadow = async (externalId: string): Promise<string> =>
    (
      await pg<{ id: string }[]>`
        insert into users (email, name, role, workspace_id) values (${shadowEmailFor(externalId)}, ${externalId}, 'member', ${WS})
        on conflict (email, workspace_id) do update set deleted_at = null returning id`
    )[0].id;
  const member = async (subject: { userId?: string; groupId?: string }, role: string): Promise<string> =>
    (
      await pg<{ id: string }[]>`
        insert into space_members (user_id, group_id, space_id, role) values (${subject.userId ?? null}, ${subject.groupId ?? null}, ${S}, ${role})
        returning id`
    )[0].id;
  const memberVersionOf = async (memberId: string) =>
    (await svc.listMembers(S)).find((m) => m.memberId === memberId)?.version;
  const snapshot = async () => ({
    spaces: await pg`select id, name, description, updated_at, deleted_at from spaces order by id`,
    members: await pg`select id, user_id, group_id, role, deleted_at, updated_at from space_members order by id`,
    users: await pg`select id, email, deleted_at from users order by id`,
    outbox: await pg`select id, table_name, payload from authz_outbox order by id`,
  });
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'applied',
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );
  const holdSpaceLock = async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const acquired = new Promise<void>((r) => (locked = r));
    const done = pg.begin(async (tx) => {
      await tx.unsafe('select 1 from spaces where id = $1 for no key update', [S]);
      locked();
      await gate;
    });
    await acquired;
    return { release, done };
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 6);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
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
    await pg`
      create table group_users (
        id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null,
        constraint group_users_group_id_user_id_unique unique (group_id, user_id)
      )`;
    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();

    const resolver = fakeWorkspaceResolver(WS);
    const bridge = new ServiceBridgeService(db as any, new UserRepo(db as any), {} as any, {} as any, resolver, {} as any);
    svc = new ServiceSpaceService(db as any, resolver, bridge);
    content = new ServiceContentService(db as any, resolver);
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    await pg`delete from group_users`;
    await pg`delete from space_members`;
    await pg`delete from spaces`;
    await pg`delete from users`;
    await pg`insert into spaces (id, name, slug, description, workspace_id) values (${S}, 'Space', 'space', 'about', ${WS})`;
    await pg`delete from authz_outbox`;
  });

  describe('space version', () => {
    it('the /v1 space read and the admin detail issue the same version; a stale rename 412s and changes nothing; a fresh one applies', async () => {
      const v = (await content.getSpace(S)).version;
      expect((await svc.getDetail(S)).version).toBe(v);
      const before = await snapshot();
      expect(await outcome(svc.update(S, { name: 'Renamed' }, 'f'.repeat(64)))).toBe('412:precondition_failed');
      expect(await snapshot()).toEqual(before);

      const res = await svc.update(S, { name: 'Renamed' }, v);
      expect(res.version).toBe((await content.getSpace(S)).version);
      expect(res.version).not.toBe(v);
      expect((await content.getSpace(S)).name).toBe('Renamed');
    });

    it('an unconditional rename answers the new version too, and "*" means the live space exists', async () => {
      const res = await svc.update(S, { description: 'new' });
      expect(res.version).toBe((await content.getSpace(S)).version);
      await expect(svc.update(S, { description: 'newer' }, '*')).resolves.toEqual({ version: expect.any(String) });
    });

    it('archive: stale → 412 (still live); fresh → archived, answering the archived space’s version', async () => {
      const v = (await content.getSpace(S)).version;
      expect(await outcome(svc.archive(S, 'f'.repeat(64)))).toBe('412:precondition_failed');
      expect((await svc.getDetail(S)).archived).toBe(false);
      const res = await svc.archive(S, v);
      const detail = await svc.getDetail(S);
      expect(detail.archived).toBe(true);
      expect(res.version).toBe(detail.version);
      expect(await outcome(svc.archive(S, '*'))).toBe('404:'); // no longer exists as a live space
    });

    it('two renames holding the same version: exactly one applies', async () => {
      const v = (await content.getSpace(S)).version;
      const results = await Promise.all(['A', 'B', 'C'].map((name) => outcome(svc.update(S, { name }, v))));
      expect(results.filter((r) => r === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r === '412:precondition_failed')).toHaveLength(2);
    });
  });

  describe('member version', () => {
    it('stale role change / removal 412 with nothing changed; fresh ones apply and answer the next read’s version', async () => {
      await member({ userId: await shadow('boss') }, 'admin');
      const m = await member({ userId: await shadow('bob') }, 'reader');
      const v = (await memberVersionOf(m)) as string;
      const before = await snapshot();
      expect(await outcome(svc.changeMemberRole(S, m, 'writer', 'boss', 'f'.repeat(64)))).toBe('412:precondition_failed');
      expect(await outcome(svc.removeMember(S, m, 'f'.repeat(64)))).toBe('412:precondition_failed');
      expect(await snapshot()).toEqual(before);

      const res = await svc.changeMemberRole(S, m, 'writer', 'boss', v);
      expect(res.version).toBe(await memberVersionOf(m));
      expect(res.version).not.toBe(v);
      await expect(svc.removeMember(S, m, res.version)).resolves.toBeUndefined();
      expect(await memberVersionOf(m)).toBeUndefined();
    });

    it('the add answers the membership version the list then shows', async () => {
      const { memberId, version } = await svc.addMember(S, { externalId: 'carol', role: 'writer', addedByExternalId: 'boss' });
      expect(version).toBe(await memberVersionOf(memberId));
    });

    it('two role changes holding the same version: exactly one applies', async () => {
      await member({ userId: await shadow('boss') }, 'admin');
      const m = await member({ userId: await shadow('bob') }, 'reader');
      const v = (await memberVersionOf(m)) as string;
      const results = await Promise.all(
        (['writer', 'admin'] as const).map((role) => outcome(svc.changeMemberRole(S, m, role, 'boss', v))),
      );
      expect(results.sort()).toEqual(['412:precondition_failed', 'applied']);
    });

    it('the compare precedes rule M and the last-admin guard: a stale version is a 412, never a 403 or 409', async () => {
      const own = await member({ userId: await shadow('alice') }, 'reader');
      expect(await outcome(svc.changeMemberRole(S, own, 'admin', 'alice', 'f'.repeat(64)))).toBe('412:precondition_failed');
      expect(await outcome(svc.changeMemberRole(S, own, 'admin', 'alice', '*'))).toBe('403:self_grant');
    });
  });

  describe('bounded waits', () => {
    it('a compared write gives up after lock_timeout (503 engine_busy); an uncompared one still waits, as before', async () => {
      await member({ userId: await shadow('boss') }, 'admin');
      const m = await member({ userId: await shadow('bob') }, 'reader');
      const holder = await holdSpaceLock();
      try {
        const started = Date.now();
        expect(await outcome(svc.changeMemberRole(S, m, 'writer', 'boss', '*'))).toBe('503:engine_busy');
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
        expect(await outcome(svc.update(S, { name: 'x' }, '*'))).toBe('503:engine_busy');
        let settled = false;
        const waiting = svc.changeMemberRole(S, m, 'writer', 'boss').finally(() => (settled = true));
        await new Promise((r) => setTimeout(r, 2500));
        expect(settled).toBe(false); // no lock_timeout without a compare: exactly the pre-#616 statements
        holder.release();
        await holder.done;
        await expect(waiting).resolves.toEqual({ version: expect.any(String) });
      } finally {
        holder.release();
        await holder.done.catch(() => undefined);
      }
    });
  });

  describe('member preview writes nothing', () => {
    it('add of an identity with no shadow user: provisionsAccount, and no users / space_members / outbox row', async () => {
      await member({ userId: await shadow('boss') }, 'admin');
      const before = await snapshot();
      await expect(
        svc.previewMember(S, { action: 'add', externalId: 'newbie', role: 'writer', addedByExternalId: 'boss' }),
      ).resolves.toEqual({
        outcome: 'would_apply',
        version: null,
        effect: { roleBefore: null, roleAfter: 'writer', provisionsAccount: true },
      });
      expect(await snapshot()).toEqual(before);
      expect(await pg`select 1 from users where email = ${shadowEmailFor('newbie')}`).toHaveLength(0);
    });

    it('add of an existing member reports its current role and version; the same role is a noop', async () => {
      const bob = await member({ userId: await shadow('bob') }, 'reader');
      const v = await memberVersionOf(bob);
      await expect(
        svc.previewMember(S, { action: 'add', externalId: 'bob', role: 'writer', addedByExternalId: 'boss' }),
      ).resolves.toEqual({ outcome: 'would_apply', version: v, effect: { roleBefore: 'reader', roleAfter: 'writer', provisionsAccount: false } });
      await expect(
        svc.previewMember(S, { action: 'add', externalId: 'bob', role: 'reader', addedByExternalId: 'boss' }),
      ).resolves.toMatchObject({ outcome: 'noop' });
    });

    it.each([
      ['a self-add (case variant, neither provisioned)', { action: 'add', externalId: 'ALICE', role: 'reader', addedByExternalId: 'alice' }, 'self_grant'],
      ['demoting the last admin', { action: 'update', role: 'reader', actorExternalId: 'boss' }, 'last_admin'],
      ['removing the last admin', { action: 'remove' }, 'last_admin'],
      ['a stale version', { action: 'update', role: 'admin', actorExternalId: 'boss', expectedVersion: 'f'.repeat(64) }, 'precondition_failed'],
    ])('%s is refused (%s) — the same decision as the write — with nothing written', async (_l, body, code) => {
      const admin = await member({ userId: await shadow('boss') }, 'admin');
      const before = await snapshot();
      const res = await svc.previewMember(S, { memberId: admin, ...body } as never);
      expect(res).toMatchObject({ outcome: 'refused', code });
      expect(res.effect.roleAfter).toBe(res.effect.roleBefore);
      expect(await snapshot()).toEqual(before);
    });

    it('a role change and a removal preview exactly what the write then does, with the current version', async () => {
      await member({ userId: await shadow('boss') }, 'admin');
      const m = await member({ userId: await shadow('bob') }, 'reader');
      const v = await memberVersionOf(m);
      const before = await snapshot();
      const change = await svc.previewMember(S, { action: 'update', memberId: m, role: 'writer', actorExternalId: 'boss', expectedVersion: v });
      expect(change).toEqual({ outcome: 'would_apply', version: v, effect: { roleBefore: 'reader', roleAfter: 'writer', provisionsAccount: false } });
      const removal = await svc.previewMember(S, { action: 'remove', memberId: m, expectedVersion: v });
      expect(removal).toEqual({ outcome: 'would_apply', version: v, effect: { roleBefore: 'reader', roleAfter: null, provisionsAccount: false } });
      expect(await snapshot()).toEqual(before);
      await svc.changeMemberRole(S, m, 'writer', 'boss', v); // …and the write with the previewed version applies
    });

    it('an archived space: a role-change preview is refused space_archived; a missing space is a 404', async () => {
      const m = await member({ userId: await shadow('bob') }, 'reader');
      await pg`update spaces set deleted_at = now() where id = ${S}`;
      await expect(
        svc.previewMember(S, { action: 'update', memberId: m, role: 'writer', actorExternalId: 'boss' }),
      ).resolves.toMatchObject({ outcome: 'refused', code: 'space_archived' });
      expect(await outcome(svc.previewMember(uuid(9), { action: 'remove', memberId: m }))).toBe('404:');
    });
  });
});
