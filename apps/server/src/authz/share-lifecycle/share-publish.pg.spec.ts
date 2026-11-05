import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { Logger, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';

// Keep the controllers' import graph off storage drivers, queues and the image pipeline, as public-share.pg.spec.ts.
jest.mock('../../core/attachment/services/attachment.service', () => ({
  __esModule: true,
  AttachmentService: class AttachmentService {},
}));
jest.mock('../../integrations/storage/storage.service', () => ({
  __esModule: true,
  StorageService: class StorageService {},
}));
jest.mock('../../integrations/environment/environment.service', () => ({
  __esModule: true,
  EnvironmentService: class EnvironmentService {},
}));

import { ShareController } from '../../core/share/share.controller';
import { ShareService } from '../../core/share/share.service';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import { TokenService } from '../../core/auth/services/token.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { LicenseCheckService } from '../../integrations/environment/license-check.service';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { HttpAuthzClient } from '../http-authz.client';
import { PdpShareRepo } from '../pdp-share.repo';
import { RetryAfterFilter } from '../request-controls/retry-after.filter';
import { ShareExpiryInstaller } from './share-expiry.installer';
import { ShareExpiryController } from './share-expiry.controller';
import { SharePublishGate, SHARE_NOT_PERMITTED_MESSAGE } from './share-publish.gate';
import { SharePublishInterceptor } from './share-publish.interceptor';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

/**
 * Real-Postgres, real-HTTP proof of the share publish gate (wiki-v2 #704) — NOT upstream Docmost code.
 *
 * Boots the REAL upstream ShareController and the fork's ShareExpiryController on Fastify with main.ts's
 * ValidationPipe, the REAL SharePublishInterceptor registered as ShareLifecycleModule registers it (a global
 * APP_INTERCEPTOR) with the REAL SharePublishGate, and the engine's RetryAfterFilter, over the REAL ShareService /
 * PageRepo / PagePermissionRepo on a real Postgres schema, with the `ShareRepo` token bound to the remote
 * `PdpShareRepo` over an installed `ccc_share_expiry` (as seam #1 binds it). The PDP is a recording stub answering
 * `[page#edit, page#share]` per page; the native edit check is a recording stub that allows (its PDP backing is
 * pdp-page-permission.repo's). Proves, on the rows:
 *  - an editor without `share` → 403 `share_not_permitted`: no `shares` row written (create), the row unchanged
 *    (update), no `ccc_share_expiry` change (expiry), and the handler's own checks never ran;
 *  - a publisher → the handler runs and writes; a slug is decided on the page's uuid;
 *  - the PDP cannot answer → 503 with `Retry-After`, nothing written;
 *  - a publisher on a restricted page still gets the handler's 400 (the gate never answers for it);
 *  - update decides on the share's page, never the body `pageId`;
 *  - expiry `set` refuses before its transaction (a held row lock does not delay the 403);
 *  - share delete stays edit-only; native mode is unchanged (no PDP call, the edit-only editor publishes).
 * Lives in the `docmost-authz-pg` CI lane; self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG share publish gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'share_publish_pg_spec';
const WS = uuid(100);
const SP = uuid(50);
const USER = uuid(900);

const PAGE = uuid(1); // (ppage) — the caller may edit; share decided per test
const OTHER = uuid(2); // (pother) — the caller may edit AND share
const RPAGE = uuid(3); // (prestricted) restricted
const SHARED = uuid(4); // (pshared) already shared (S_SHARED), live
const EXPIRED = uuid(5); // (pexpired) shared (S_EXPIRED), expired
const S_SHARED = uuid(501);
const S_EXPIRED = uuid(502);

type Decide = (pageId: string) => [boolean, boolean] | null;

d('share publish gate over real rows and HTTP (#704)', () => {
  let pg: postgres.Sql;
  let db: Kysely<any>;
  let decide: Decide;
  const pdp = { tryCheckBulk: jest.fn() };
  const access = { validateCanEdit: jest.fn(), validateCanView: jest.fn() };

  /** Everyone may edit every page; only OTHER (and whatever a test says) may be published. */
  const editOnly: Decide = (pageId) => [true, pageId === OTHER];
  const publisher: Decide = () => [true, true];

  const seed = async () => {
    await pg`delete from ccc_share_expiry`;
    await pg`delete from shares`;
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from spaces`;
    await pg`delete from workspaces`;
    await pg`insert into workspaces (id, name, settings) values (${WS}, 'ws', '{}'::jsonb)`;
    await pg`insert into spaces (id, name, workspace_id, settings) values (${SP}, 'Eng', ${WS}, '{}'::jsonb)`;
    const page = (id: string, slug: string) => pg`
      insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, position)
      values (${id}, ${slug}, ${'Title ' + slug}, ${SP}, ${WS}, ${USER}, 'a0')`;
    await page(PAGE, 'ppage');
    await page(OTHER, 'pother');
    await page(RPAGE, 'prestricted');
    await page(SHARED, 'pshared');
    await page(EXPIRED, 'pexpired');
    await pg`insert into page_access (page_id, workspace_id, space_id, access_level, creator_id)
             values (${RPAGE}, ${WS}, ${SP}, 'restricted', ${USER})`;
    await pg`insert into shares (id, key, page_id, include_sub_pages, search_indexing, creator_id, space_id, workspace_id)
             values (${S_SHARED}, 'kshared', ${SHARED}, false, false, ${USER}, ${SP}, ${WS}),
                    (${S_EXPIRED}, 'kexpired', ${EXPIRED}, false, false, ${USER}, ${SP}, ${WS})`;
    await pg`insert into ccc_share_expiry (share_id, expires_at) values
             (${S_SHARED}, now() + interval '30 days'), (${S_EXPIRED}, now() - interval '1 second')`;
  };

  const sharesOf = (pageId: string) =>
    pg`select id, include_sub_pages, search_indexing from shares where page_id = ${pageId}`;
  const expiryOf = async (shareId: string) =>
    (await pg`select expires_at from ccc_share_expiry where share_id = ${shareId}`)[0]?.expires_at as Date | null;

  async function bootApp(mode: AuthzMode) {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShareController, ShareExpiryController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: AUTHZ_MODE, useValue: mode },
        RemoteOnlyGuard,
        ShareService,
        // Remote mode's binding (seam #1); native mode keeps the upstream repo.
        {
          provide: ShareRepo,
          inject: [KYSELY_MODULE_CONNECTION_TOKEN(), PagePermissionRepo],
          useFactory: (k: Kysely<any>, pp: PagePermissionRepo) =>
            mode === 'remote' ? new PdpShareRepo(k as any, {} as any, pp) : new ShareRepo(k as any, {} as any),
        },
        PageRepo,
        PagePermissionRepo,
        // ShareLifecycleModule's registration of the gate.
        { provide: HttpAuthzClient, useValue: pdp },
        SharePublishGate,
        { provide: APP_INTERCEPTOR, useClass: SharePublishInterceptor },
        { provide: APP_FILTER, useClass: RetryAfterFilter },
        { provide: TokenService, useValue: {} },
        { provide: TransclusionService, useValue: {} },
        { provide: SpaceMemberRepo, useValue: {} },
        { provide: GroupRepo, useValue: {} },
        { provide: CACHE_MANAGER, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: () => true } },
        { provide: PageAccessService, useValue: access },
        { provide: LicenseCheckService, useValue: { resolveFeatures: () => [] } },
        { provide: AUDIT_SERVICE, useValue: { log: jest.fn() } },
      ],
    })
      // The real guard's contract: an authenticated request carries `req.user = { user, workspace }`.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { user: { id: USER }, workspace: { id: WS } };
          return true;
        },
      })
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    if (mode === 'remote') expect(app.get(ShareRepo)).toBeInstanceOf(PdpShareRepo);
    return app;
  }

  let app: NestFastifyApplication;
  const post = (url: string, payload: object, on: NestFastifyApplication = app) =>
    on.inject({ method: 'POST', url, payload });
  /** The page ids the PDP was asked about, per call. */
  const asked = () => pdp.tryCheckBulk.mock.calls.map((c) => c[1].map((x: { permission: string; resourceId: string }) => `${x.permission}:${x.resourceId}`));

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(pg);
    // The Docmost columns these queries select and filter on, as in the migrations (as public-share.pg.spec.ts).
    await pg`create table workspaces (id uuid primary key, name varchar, settings jsonb, license_key varchar,
                                      plan varchar, hostname varchar, deleted_at timestamptz)`;
    await pg`create table spaces (id uuid primary key, name varchar, slug varchar, workspace_id uuid not null,
                                  settings jsonb, deleted_at timestamptz)`;
    await pg`
      create table pages (
        id uuid primary key, slug_id varchar not null unique, title varchar, icon varchar, cover_photo varchar,
        position varchar, parent_page_id uuid references pages (id) on delete cascade, creator_id uuid,
        last_updated_by_id uuid, space_id uuid not null, workspace_id uuid not null,
        is_locked boolean not null default false, is_base boolean not null default false, contributor_ids uuid[],
        content jsonb, text_content text, ydoc bytea, tsv tsvector,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, deleted_by_id uuid
      )`;
    await pg`
      create table page_access (
        id uuid primary key default gen_random_uuid(), page_id uuid not null unique references pages (id) on delete cascade,
        workspace_id uuid not null, space_id uuid not null, access_level varchar not null, creator_id uuid,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      )`;
    await pg`
      create table shares (
        id uuid primary key default gen_random_uuid(), key varchar not null,
        page_id uuid references pages (id) on delete cascade, include_sub_pages boolean default false,
        search_indexing boolean default false, creator_id uuid, space_id uuid not null, workspace_id uuid not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, unique (key, workspace_id)
      )`;
    await new ShareExpiryInstaller(db as any, 'remote').install();
    app = await bootApp('remote');
  });

  beforeEach(async () => {
    await seed();
    decide = editOnly;
    pdp.tryCheckBulk.mockReset().mockImplementation(async (_s: unknown, checks: Array<{ resourceId: string }>) =>
      decide(checks[0].resourceId),
    );
    access.validateCanEdit.mockReset().mockResolvedValue({ hasRestriction: false });
    access.validateCanView.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await db?.destroy();
  });

  describe('POST /shares/create', () => {
    it('an editor without share → 403 share_not_permitted, and no shares row is written', async () => {
      const res = await post('/shares/create', { pageId: PAGE, includeSubPages: true });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ message: SHARE_NOT_PERMITTED_MESSAGE, code: 'share_not_permitted' });
      expect(await sharesOf(PAGE)).toEqual([]);
      expect(access.validateCanEdit).not.toHaveBeenCalled();
      expect(asked()).toEqual([[`edit:${PAGE}`, `share:${PAGE}`]]);
    });

    it('a publisher (by slug) → 200 and one shares row; the PDP is asked about the uuid', async () => {
      decide = publisher;
      const res = await post('/shares/create', { pageId: 'ppage', includeSubPages: true });
      expect(res.statusCode).toBe(200);
      expect(await sharesOf(PAGE)).toEqual([expect.objectContaining({ include_sub_pages: true })]);
      expect(access.validateCanEdit).toHaveBeenCalledTimes(1);
      expect(asked()).toEqual([[`edit:${PAGE}`, `share:${PAGE}`]]);
    });

    it('the PDP cannot answer → 503 with Retry-After, and nothing is written', async () => {
      decide = () => null;
      const res = await post('/shares/create', { pageId: PAGE });
      expect(res.statusCode).toBe(503);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(2);
      expect(await sharesOf(PAGE)).toEqual([]);
      expect(access.validateCanEdit).not.toHaveBeenCalled();
    });

    it('a publisher on a restricted page still gets the handler’s 400, and nothing is written', async () => {
      decide = publisher;
      const res = await post('/shares/create', { pageId: RPAGE });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Cannot share a restricted page');
      expect(await sharesOf(RPAGE)).toEqual([]);
    });

    it('an unknown page → the handler’s 404 without a PDP call; a missing pageId → 400 without one', async () => {
      expect((await post('/shares/create', { pageId: 'no-such-slug' })).statusCode).toBe(404);
      expect((await post('/shares/create', { includeSubPages: true })).statusCode).toBe(400);
      expect(pdp.tryCheckBulk).not.toHaveBeenCalled();
    });
  });

  describe('POST /shares/update', () => {
    it('an editor without share → 403, and the row is unchanged', async () => {
      const res = await post('/shares/update', { shareId: S_SHARED, includeSubPages: true, searchIndexing: true });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'share_not_permitted' });
      expect(await sharesOf(SHARED)).toEqual([{ id: S_SHARED, include_sub_pages: false, search_indexing: false }]);
    });

    it('decides on the SHARE’s page: a body pageId the caller may publish does not unlock it', async () => {
      const res = await post('/shares/update', { shareId: S_SHARED, pageId: OTHER, includeSubPages: true });
      expect(res.statusCode).toBe(403);
      expect(asked()).toEqual([[`edit:${SHARED}`, `share:${SHARED}`]]);
      expect(await sharesOf(SHARED)).toEqual([expect.objectContaining({ include_sub_pages: false })]);
    });

    it('a publisher → 200 and the row is updated', async () => {
      decide = publisher;
      const res = await post('/shares/update', { shareId: S_SHARED, includeSubPages: true, searchIndexing: true });
      expect(res.statusCode).toBe(200);
      expect(await sharesOf(SHARED)).toEqual([{ id: S_SHARED, include_sub_pages: true, search_indexing: true }]);
    });

    it('an expired share (the PdpShareRepo veto) → 404 Share not found, without a PDP call', async () => {
      decide = publisher;
      const res = await post('/shares/update', { shareId: S_EXPIRED, includeSubPages: true });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe('Share not found');
      expect(pdp.tryCheckBulk).not.toHaveBeenCalled();
    });
  });

  describe('POST /shares/expiry', () => {
    it('an editor without share → 403, and the expiry is unchanged', async () => {
      const before = await expiryOf(S_SHARED);
      const res = await post('/shares/expiry', { shareId: S_SHARED, expiresInDays: null });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'share_not_permitted' });
      expect(await expiryOf(S_SHARED)).toEqual(before);
      expect(access.validateCanEdit).not.toHaveBeenCalled();
    });

    it('a publisher → 200 and "Never" is stored', async () => {
      decide = publisher;
      const res = await post('/shares/expiry', { shareId: S_SHARED, expiresInDays: null });
      expect(res.statusCode).toBe(200);
      expect(await expiryOf(S_SHARED)).toBeNull();
    });

    it('refuses before its transaction: a row lock held elsewhere does not delay the 403 (no engine_busy)', async () => {
      const hold = postgres(PG_URL as string, { max: 1, onnotice: () => {}, connection: { search_path: SCHEMA } });
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let lockedNow!: () => void;
      const locked = new Promise<void>((r) => (lockedNow = r));
      const holder = hold.begin(async (t) => {
        const tx = t as unknown as postgres.Sql;
        await tx`select id from shares where id = ${S_SHARED} for update`;
        lockedNow();
        await released;
      });
      try {
        await locked;
        const res = await post('/shares/expiry', { shareId: S_SHARED, expiresInDays: 365 });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'share_not_permitted' });
      } finally {
        release();
        await holder.catch(() => undefined);
        await hold.end({ timeout: 5 });
      }
    });

    it('the PDP cannot answer → 503 with Retry-After, and the expiry is unchanged', async () => {
      decide = () => null;
      const before = await expiryOf(S_SHARED);
      const res = await post('/shares/expiry', { shareId: S_SHARED, expiresInDays: 365 });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(await expiryOf(S_SHARED)).toEqual(before);
    });
  });

  describe('POST /shares/delete stays edit-only (narrowing)', () => {
    it('an editor without share unpublishes: 200, the row is gone, the PDP publish check is never asked', async () => {
      const res = await post('/shares/delete', { shareId: S_SHARED });
      expect(res.statusCode).toBe(200);
      expect(await sharesOf(SHARED)).toEqual([]);
      expect(pdp.tryCheckBulk).not.toHaveBeenCalled();
      expect(access.validateCanEdit).toHaveBeenCalledTimes(1);
    });
  });

  describe('native mode is unchanged', () => {
    let native: NestFastifyApplication;
    beforeAll(async () => {
      native = await bootApp('native');
    });
    afterAll(async () => {
      await native?.close();
    });

    it('the edit-only editor publishes and updates (no PDP call); the expiry API does not exist', async () => {
      expect((await post('/shares/create', { pageId: PAGE }, native)).statusCode).toBe(200);
      expect(await sharesOf(PAGE)).toHaveLength(1);
      expect((await post('/shares/update', { shareId: S_SHARED, includeSubPages: true }, native)).statusCode).toBe(200);
      expect(await sharesOf(SHARED)).toEqual([expect.objectContaining({ include_sub_pages: true })]);
      expect((await post('/shares/expiry', { shareId: S_SHARED, expiresInDays: 7 }, native)).statusCode).toBe(404);
      expect(pdp.tryCheckBulk).not.toHaveBeenCalled();
    });
  });
});
