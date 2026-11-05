import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { Readable } from 'node:stream';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';

// Keep the controllers' import graph off storage drivers, queues and the image pipeline (each is replaced by a
// value below), exactly as workspace-ability-http.spec.ts does for the same controller.
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
import { ShareSeoController } from '../../core/share/share-seo.controller';
import { ShareService } from '../../core/share/share.service';
import { AttachmentController } from '../../core/attachment/attachment.controller';
import { AttachmentService } from '../../core/attachment/services/attachment.service';
import { SearchController } from '../../core/search/search.controller';
import { SearchService } from '../../core/search/search.service';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import { TokenService } from '../../core/auth/services/token.service';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { StorageService } from '../../integrations/storage/storage.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { LicenseCheckService } from '../../integrations/environment/license-check.service';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { searchServiceProvider } from '../search/search.provider';
import { PdpSearchService } from '../search/pdp-search.service';
import { PdpShareRepo } from '../pdp-share.repo';
import { ShareExpiryInstaller } from './share-expiry.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

/**
 * Real-Postgres proof of the #660/#334 "publicly readable now" choke point — NOT upstream Docmost code.
 *
 * Boots the REAL upstream ShareController, ShareSeoController, AttachmentController (`GET /files/public`) and
 * SearchController (`/search/share-search`, through the real remote `searchServiceProvider`) on Fastify, over the
 * REAL ShareService / PageRepo / PagePermissionRepo / AttachmentRepo / TokenService on a real Postgres schema (the
 * Docmost columns these queries touch), with the `ShareRepo` token bound to the remote `PdpShareRepo` over an
 * installed `ccc_share_expiry` (as seam #1 binds it in remote mode). Only the collaborators the public paths never
 * reach are stubs.
 *
 * The seams proved here:
 *  - `ShareService.getShareForPage` tail: sharing allowed (incl. the new archived-space arm), the REQUESTED page
 *    (resolved from a slug) not under a restriction, and the `ShareRepo.findById` re-read (the repo veto point the
 *    remote PdpShareRepo uses for expiry).
 *  - `POST /shares/info`: workspace match + restricted-ancestor check.
 *  - `GET /files/public`: the use-time share check and `Cache-Control: private, no-cache`.
 *  - `PdpSearchService` anonymous share-search: `isSharingAllowed` first.
 * Each deny case that the stock code would have served carries a "control" that neutralizes the new predicate and
 * shows the same request would have answered, so no row here is vacuous. Self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG public share choke point', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'public_share_pg_spec';
const SECRET = 'public-share-pg-spec-secret';
const WS = uuid(100);
const FWS = uuid(200);
const SP = uuid(50);
const SP_OFF = uuid(51);
const SP_ARCH = uuid(52);
const USER = uuid(900);

// Pages (slug in parentheses).
const ROOT = uuid(1); // (proot) shared, includeSubPages
const CHILD = uuid(2); // (pchild) under ROOT
const RCHILD = uuid(3); // (prchild) under ROOT, restricted
const RGRAND = uuid(4); // (prgrand) under RCHILD
const NOSUB = uuid(5); // (pnosub) shared, includeSubPages=false
const NOSUB_CHILD = uuid(6); // (pnosubchild) under NOSUB
const DIRECT = uuid(7); // (pdirect) shared directly, carries ATT
const RPARENT = uuid(8); // (prparent) restricted, unshared
const MV = uuid(9); // (pmv) shared directly, later moved under RPARENT
const UNSHARED = uuid(10); // (punshared)
const TR = uuid(11); // (ptr) shared, trashed (share row left behind)
const OFFP = uuid(12); // (poff) shared, in SP_OFF (sharing disabled)
const ARCHP = uuid(13); // (parch) shared, in SP_ARCH (archived)

const S_ROOT = uuid(501);
const S_NOSUB = uuid(502);
const S_DIRECT = uuid(503);
const S_MV = uuid(504);
const S_TR = uuid(505);
const S_OFF = uuid(506);
const S_ARCH = uuid(507);

const ATT = uuid(800); // on DIRECT
const ATT_R = uuid(801); // on RCHILD (restricted)

const TITLE = {
  [ROOT]: 'Root Public Title',
  [CHILD]: 'Child Public Title',
  [RCHILD]: 'Secret Restricted Child',
  [RGRAND]: 'Secret Grandchild',
  [DIRECT]: 'Direct Shared Title',
  [MV]: 'Moved Page Title',
  [OFFP]: 'Disabled Space Title',
  [ARCHP]: 'Archived Space Title',
  [TR]: 'Trashed Page Title',
} as Record<string, string>;

const BYTES = Buffer.from('PUBLIC-BYTES');
const INDEX_HTML = '<html><head><title>Docmost</title><!--meta-tags--></head><body></body></html>';

d('public share reads over real rows (#660/#334)', () => {
  let pg: postgres.Sql;
  let db: Kysely<any>;
  let app: NestFastifyApplication;
  let shareService: ShareService;
  let shareRepo: ShareRepo;
  let pagePermissionRepo: PagePermissionRepo;
  let attachmentRepo: AttachmentRepo;
  let tokenService: TokenService;
  let pageRepo: PageRepo;
  /** What the transclusion stub was handed as the accessible source set. */
  let lastAccessibleSet: Set<string> | undefined;

  const wsObj = (id: string) => ({ id, licenseKey: null, plan: null });

  const seed = async () => {
    await pg`delete from attachments`;
    await pg`delete from shares`;
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from spaces`;
    await pg`delete from workspaces`;
    await pg`insert into workspaces (id, name, settings) values (${WS}, 'ws', '{}'::jsonb), (${FWS}, 'fws', '{}'::jsonb)`;
    await pg`insert into spaces (id, name, workspace_id, settings, deleted_at) values
      (${SP}, 'Eng', ${WS}, '{}'::jsonb, null),
      (${SP_OFF}, 'Off', ${WS}, '{"sharing":{"disabled":true}}'::jsonb, null),
      (${SP_ARCH}, 'Arch', ${WS}, '{}'::jsonb, now())`;
    const page = (id: string, slug: string, o: { parent?: string; space?: string; trashed?: boolean } = {}) => pg`
      insert into pages (id, slug_id, title, space_id, parent_page_id, workspace_id, creator_id, position, content,
                         text_content, tsv, deleted_at)
      values (${id}, ${slug}, ${TITLE[id] ?? 'Title ' + slug}, ${o.space ?? SP}, ${o.parent ?? null}, ${WS}, ${USER},
              'a0', ${pg.json({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'roadmap' }] }] })},
              'roadmap body', to_tsvector('english', 'Roadmap'), ${o.trashed ? new Date() : null})`;
    await page(ROOT, 'proot');
    await page(CHILD, 'pchild', { parent: ROOT });
    await page(RCHILD, 'prchild', { parent: ROOT });
    await page(RGRAND, 'prgrand', { parent: RCHILD });
    await page(NOSUB, 'pnosub');
    await page(NOSUB_CHILD, 'pnosubchild', { parent: NOSUB });
    await page(DIRECT, 'pdirect');
    await page(RPARENT, 'prparent');
    await page(MV, 'pmv');
    await page(UNSHARED, 'punshared');
    await page(TR, 'ptr', { trashed: true });
    await page(OFFP, 'poff', { space: SP_OFF });
    await page(ARCHP, 'parch', { space: SP_ARCH });
    await restrict(RCHILD);
    await restrict(RPARENT);
    const share = (id: string, key: string, pageId: string, sub: boolean, space = SP) => pg`
      insert into shares (id, key, page_id, include_sub_pages, search_indexing, creator_id, space_id, workspace_id)
      values (${id}, ${key}, ${pageId}, ${sub}, false, ${USER}, ${space}, ${WS})`;
    await share(S_ROOT, 'kroot', ROOT, true);
    await share(S_NOSUB, 'knosub', NOSUB, false);
    await share(S_DIRECT, 'kdirect', DIRECT, false);
    await share(S_MV, 'kmv', MV, false);
    await share(S_TR, 'ktr', TR, false);
    await share(S_OFF, 'koff', OFFP, false, SP_OFF);
    await share(S_ARCH, 'karch', ARCHP, false, SP_ARCH);
    await pg`insert into attachments (id, file_name, file_path, file_size, file_ext, mime_type, type, creator_id,
                                      page_id, space_id, workspace_id) values
      (${ATT}, 'a.png', 'files/a.png', ${BYTES.length}, '.png', 'image/png', 'file', ${USER}, ${DIRECT}, ${SP}, ${WS}),
      (${ATT_R}, 'r.png', 'files/r.png', ${BYTES.length}, '.png', 'image/png', 'file', ${USER}, ${RCHILD}, ${SP}, ${WS})`;
  };

  const restrict = (pageId: string) =>
    pg`insert into page_access (page_id, workspace_id, space_id, access_level, creator_id)
       select id, workspace_id, space_id, 'restricted', ${USER} from pages where id = ${pageId}`;

  /**
   * Control: run `fn` with the new tail predicates neutralized (sharing always allowed, never restricted) — what the
   * stock `getShareForPage` decided. A deny row whose control answers proves the deny comes from the new seam.
   */
  const withStockPredicates = async <T>(fn: () => Promise<T>): Promise<T> => {
    const a = jest.spyOn(shareService, 'isSharingAllowed').mockResolvedValue(true);
    const b = jest.spyOn(pagePermissionRepo, 'hasRestrictedAncestor').mockResolvedValue(false);
    try {
      return await fn();
    } finally {
      a.mockRestore();
      b.mockRestore();
    }
  };

  const post = (url: string, payload: object, ws = WS) =>
    app.inject({ method: 'POST', url, payload, headers: { 'x-test-ws': ws } });

  const seo = async (slug: string) => {
    // ShareSeoController reads the built client's index.html; serve a fixture for exactly that path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    const isIndexDir = (p: unknown) => String(p).endsWith('client/dist');
    const isIndex = (p: unknown) => String(p).endsWith('client/dist/index.html');
    const origExists = fs.existsSync;
    const origRead = fs.readFileSync;
    const origStream = fs.createReadStream;
    const s1 = jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => (isIndexDir(p) ? true : origExists(p)));
    const s2 = jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation((p: any, ...r: any[]) => (isIndex(p) ? INDEX_HTML : origRead(p, ...r)));
    const s3 = jest
      .spyOn(fs, 'createReadStream')
      .mockImplementation((p: any, ...r: any[]) => (isIndex(p) ? Readable.from([INDEX_HTML]) : origStream(p, ...r)));
    try {
      const res = await app.inject({ method: 'GET', url: `/share/p/some-title-${slug}` });
      expect(res.statusCode).toBe(200);
      return res.body;
    } finally {
      s1.mockRestore();
      s2.mockRestore();
      s3.mockRestore();
    }
  };

  const mint = (attachmentId: string, pageId: string) =>
    tokenService.generateAttachmentToken({ attachmentId, pageId, workspaceId: WS });
  const getFile = (attachmentId: string, jwt: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/files/public/${attachmentId}/a.png?jwt=${encodeURIComponent(jwt)}`,
      headers: { 'x-test-ws': WS, ...headers },
    });

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(pg);
    // The Docmost columns these queries select and filter on, as in the migrations.
    await pg`create table workspaces (id uuid primary key, name varchar, settings jsonb, license_key varchar,
                                      plan varchar, hostname varchar, deleted_at timestamptz)`;
    await pg`create table spaces (id uuid primary key, name varchar, slug varchar, workspace_id uuid not null,
                                  settings jsonb, deleted_at timestamptz)`;
    await pg`create table users (id uuid primary key, name varchar, avatar_url varchar, email varchar, workspace_id uuid)`;
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
    await pg`
      create table attachments (
        id uuid primary key, file_name varchar not null, file_path varchar not null, file_size int8,
        file_ext varchar not null, mime_type varchar, type varchar, creator_id uuid, page_id uuid, space_id uuid,
        ai_chat_id uuid, workspace_id uuid not null, created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(), deleted_at timestamptz
      )`;
    await pg`create function f_unaccent(text) returns text language sql immutable as $$ select $1 $$`;
    await new ShareExpiryInstaller(db as any, 'remote').install();
    await pg`insert into users (id, name) values (${USER}, 'Author')`;

    const environmentService = {
      isSelfHosted: () => true,
      isCloud: () => false,
      getAppSecret: () => SECRET,
      getSearchDriver: () => 'database',
    };
    const transclusionService = {
      lookupWithAccessSet: jest.fn(async (refs: Array<{ sourcePageId: string; transclusionId: string }>, set: Set<string>) => {
        lastAccessibleSet = set;
        return {
          items: refs.map((r) => ({ sourcePageId: r.sourcePageId, transclusionId: r.transclusionId, status: 'no_access' })),
        };
      }),
    };
    const storageService = {
      readStream: async () => Readable.from([BYTES]),
      readRangeStream: async (_p: string, r: { start: number; end: number }) =>
        Readable.from([BYTES.subarray(r.start, r.end + 1)]),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ShareController, ShareSeoController, AttachmentController, SearchController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: AUTHZ_MODE, useValue: 'remote' },
        ShareService,
        // Remote mode's binding (seam #1): the read-time expiry veto is real here, not mocked.
        {
          provide: ShareRepo,
          inject: [KYSELY_MODULE_CONNECTION_TOKEN(), PagePermissionRepo],
          useFactory: (k: Kysely<any>, pp: PagePermissionRepo) => new PdpShareRepo(k as any, {} as any, pp),
        },
        PageRepo,
        PagePermissionRepo,
        AttachmentRepo,
        TokenService,
        searchServiceProvider,
        { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
        { provide: EnvironmentService, useValue: environmentService },
        { provide: TransclusionService, useValue: transclusionService },
        { provide: SpaceMemberRepo, useValue: {} },
        { provide: GroupRepo, useValue: {} },
        { provide: CACHE_MANAGER, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: () => true } },
        { provide: PageAccessService, useValue: { validateCanView: jest.fn().mockResolvedValue(undefined) } },
        { provide: LicenseCheckService, useValue: { resolveFeatures: () => [] } },
        { provide: AUDIT_SERVICE, useValue: { log: jest.fn() } },
        { provide: WorkspaceRepo, useValue: { findFirst: async () => wsObj(WS) } },
        { provide: AttachmentService, useValue: {} },
        { provide: StorageService, useValue: storageService },
        { provide: SpaceAbilityFactory, useValue: {} },
        { provide: WorkspaceAbilityFactory, useValue: {} },
      ],
    })
      // The real guard's contract: an authenticated request carries `req.user = { user, workspace }`.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { user: { id: USER }, workspace: wsObj(WS) };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // DomainMiddleware's contract: the resolved workspace rides on the raw request.
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (req: any) => {
        const ws = req.headers['x-test-ws'];
        if (ws) req.raw.workspace = wsObj(ws);
      });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    shareService = app.get(ShareService);
    shareRepo = app.get(ShareRepo);
    pagePermissionRepo = app.get(PagePermissionRepo);
    attachmentRepo = app.get(AttachmentRepo);
    tokenService = app.get(TokenService);
    pageRepo = app.get(PageRepo);
    expect(app.get(SearchService)).toBeInstanceOf(PdpSearchService);
    expect(shareRepo).toBeInstanceOf(PdpShareRepo);
  });

  beforeEach(async () => {
    lastAccessibleSet = undefined;
    await seed();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await db?.destroy();
  });

  describe('getShareForPage — the one choke point', () => {
    const allow: Array<[string, string, string]> = [
      ['a direct share, by uuid', DIRECT, S_DIRECT],
      ['a direct share, by slug', 'pdirect', S_DIRECT],
      ['the share root of an includeSubPages share', ROOT, S_ROOT],
      ['an includeSubPages child, by slug', 'pchild', S_ROOT],
      ['an includeSubPages child, by uuid', CHILD, S_ROOT],
    ];
    it.each(allow)('allows %s', async (_n, ref, shareId) => {
      expect((await shareService.getShareForPage(ref, WS))?.id).toBe(shareId);
    });

    type Deny = { name: string; ref: string; setup?: () => Promise<unknown>; stockLeaks: boolean; ws?: string };
    const deny: Deny[] = [
      { name: 'an unshared page', ref: UNSHARED, stockLeaks: false },
      { name: 'a restricted share root (restricted after sharing)', ref: ROOT, setup: () => restrict(ROOT), stockLeaks: true },
      { name: 'a page under a restricted ancestor', ref: RGRAND, stockLeaks: true },
      { name: 'a restricted page below the share root, requested BY SLUG', ref: 'prchild', stockLeaks: true },
      { name: 'a restricted page below the share root, by uuid', ref: RCHILD, stockLeaks: true },
      {
        name: 'a shared page moved under a restricted parent',
        ref: 'pmv',
        setup: () => pg`update pages set parent_page_id = ${RPARENT} where id = ${MV}`,
        stockLeaks: true,
      },
      { name: 'a share in a space with sharing disabled', ref: OFFP, stockLeaks: true },
      {
        name: 'a share with sharing disabled for the workspace',
        ref: DIRECT,
        setup: () => pg`update workspaces set settings = '{"sharing":{"disabled":true}}'::jsonb where id = ${WS}`,
        stockLeaks: true,
      },
      { name: 'a share in an archived space', ref: 'parch', stockLeaks: true },
      { name: 'a trashed page (share row left behind)', ref: TR, stockLeaks: false },
      { name: 'an includeSubPages=false child', ref: NOSUB_CHILD, stockLeaks: false },
      { name: 'another workspace', ref: DIRECT, ws: FWS, stockLeaks: false },
    ];
    it.each(deny)('denies $name', async ({ ref, setup, stockLeaks, ws }) => {
      await setup?.();
      expect(await shareService.getShareForPage(ref, ws ?? WS)).toBeUndefined();
      // Control: the stock predicates — would the pre-fix code have answered?
      const stock = await withStockPredicates(() => shareService.getShareForPage(ref, ws ?? WS));
      if (stockLeaks) expect(stock).toBeTruthy();
      else expect(stock).toBeUndefined();
    });

    it('the trashed page still has its share row (the deny is the CTE, not a missing row)', async () => {
      expect(await shareRepo.findById(S_TR)).toBeTruthy();
    });

    it('honors the ShareRepo veto (the remote PdpShareRepo answers undefined for an expired share)', async () => {
      expect((await shareService.getShareForPage(DIRECT, WS))?.id).toBe(S_DIRECT);
      const veto = jest.spyOn(shareRepo, 'findById').mockResolvedValue(undefined as any);
      expect(await shareService.getShareForPage(DIRECT, WS)).toBeUndefined();
      expect(await shareService.getShareForPage('pchild', WS)).toBeUndefined();
      expect(veto).toHaveBeenCalledWith(S_DIRECT);
      expect(veto).toHaveBeenCalledWith(S_ROOT);
    });

    it('isSharingAllowed: an archived space is never public (control: the same space un-archived is)', async () => {
      expect(await shareService.isSharingAllowed(WS, SP_ARCH)).toBe(false);
      await pg`update spaces set deleted_at = null where id = ${SP_ARCH}`;
      expect(await shareService.isSharingAllowed(WS, SP_ARCH)).toBe(true);
    });
  });

  describe('HTTP consumers', () => {
    it('SEO: a shared page gets og:title (control) — a since-restricted root does not leak its title', async () => {
      expect(await seo('proot')).toContain(`og:title" content="${TITLE[ROOT]}"`);
      await restrict(ROOT);
      const html = await seo('proot');
      expect(html).not.toContain(TITLE[ROOT]);
      expect(html).not.toContain('og:title');
      // Control: the stock predicates would have emitted the confidential title.
      expect(await withStockPredicates(() => seo('proot'))).toContain(TITLE[ROOT]);
    });

    it.each([
      ['a restricted page below the root, by slug', 'prchild'],
      ['a page under a restricted ancestor', 'prgrand'],
      ['a share in an archived space', 'parch'],
      ['a share in a space with sharing disabled', 'poff'],
    ])('SEO: %s gets the bare index (control: stock would have emitted og:title)', async (_n, slug) => {
      const html = await seo(slug);
      expect(html).not.toContain('og:title');
      expect(html).toContain('<title>Docmost</title>');
      expect(await withStockPredicates(() => seo(slug))).toContain('og:title');
    });

    it('/page-info: allows a shared child; denies an archived space (stock served it) and a restricted slug', async () => {
      const ok = await post('/shares/page-info', { pageId: 'pchild' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().page.title).toBe(TITLE[CHILD]);
      expect((await post('/shares/page-info', { pageId: 'parch' })).statusCode).toBe(404);
      expect((await post('/shares/page-info', { pageId: 'prchild' })).statusCode).toBe(404);
      expect((await withStockPredicates(() => post('/shares/page-info', { pageId: 'parch' }))).statusCode).toBe(200);
    });

    it('/for-page: a restricted page answers no share (control: stock answered the root share and its title)', async () => {
      const r = await post('/shares/for-page', { pageId: RCHILD });
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe('');
      const stock = await withStockPredicates(() => post('/shares/for-page', { pageId: RCHILD }));
      expect(stock.json().sharedPage.title).toBe(TITLE[ROOT]);
      expect((await post('/shares/for-page', { pageId: CHILD })).json().id).toBe(S_ROOT);
    });

    it('/info: answers a live share (control), 404s a foreign workspace with the same body as an unknown share', async () => {
      const ok = await post('/shares/info', { shareId: S_DIRECT });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().sharedPage.title).toBe(TITLE[DIRECT]);
      const foreign = await post('/shares/info', { shareId: S_DIRECT }, FWS);
      const unknown = await post('/shares/info', { shareId: uuid(599) });
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(foreign.body).not.toContain(TITLE[DIRECT]);
      // Control: the stock condition (row found, sharing allowed in ITS workspace) would have answered.
      const row = await shareRepo.findById(S_DIRECT);
      expect(row).toBeTruthy();
      expect(await shareService.isSharingAllowed(row.workspaceId, row.spaceId)).toBe(true);
    });

    it('/info: a since-restricted shared page 404s like an unknown share (control: stock condition held)', async () => {
      await restrict(DIRECT);
      const r = await post('/shares/info', { shareId: S_DIRECT });
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe((await post('/shares/info', { shareId: uuid(599) })).body);
      expect(r.body).not.toContain(TITLE[DIRECT]);
      const row = await shareRepo.findById(S_DIRECT);
      expect(row && (await shareService.isSharingAllowed(row.workspaceId, row.spaceId))).toBe(true);
    });

    it('/info and /tree: an archived space 404s (control: un-archived it answers)', async () => {
      expect((await post('/shares/info', { shareId: S_ARCH })).statusCode).toBe(404);
      expect((await post('/shares/tree', { shareId: S_ARCH })).statusCode).toBe(404);
      await pg`update spaces set deleted_at = null where id = ${SP_ARCH}`;
      expect((await post('/shares/info', { shareId: S_ARCH })).statusCode).toBe(200);
      expect((await post('/shares/tree', { shareId: S_ARCH })).statusCode).toBe(200);
    });

    it('transclusion: only sources public NOW reach the access set (archived, disabled, restricted excluded)', async () => {
      const refs = [DIRECT, ARCHP, OFFP, RCHILD].map((sourcePageId) => ({ sourcePageId, transclusionId: 't1' }));
      const r = await post('/shares/transclusion/lookup', { shareId: S_ROOT, references: refs });
      expect(r.statusCode).toBe(200);
      expect([...(lastAccessibleSet ?? [])]).toEqual([DIRECT]);
    });
  });

  describe('GET /files/public — the use-time share check (#334)', () => {
    it('serves a shared page attachment with Cache-Control: private, no-cache', async () => {
      const jwt = await mint(ATT, DIRECT);
      const r = await getFile(ATT, jwt);
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.equals(BYTES)).toBe(true);
      expect(r.headers['cache-control']).toBe('private, no-cache');
      const ranged = await getFile(ATT, jwt, { range: 'bytes=0-3' });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['cache-control']).toBe('private, no-cache');
    });

    /** The stock checks (token valid, minted for this attachment's page) still pass — so only the seam denies. */
    const expectStockChecksPass = async (jwt: string, attachmentId: string) => {
      const payload = await tokenService.verifyJwt(jwt, JwtType.ATTACHMENT);
      const att = await attachmentRepo.findById(attachmentId);
      expect(payload.attachmentId).toBe(attachmentId);
      expect(att.pageId).toBe(payload.pageId);
      expect(att.workspaceId).toBe(WS);
    };

    it.each([
      ['unshare', () => pg`delete from shares where id = ${S_DIRECT}`],
      ['restrict', () => restrict(DIRECT)],
      ['archive the space', () => pg`update spaces set deleted_at = now() where id = ${SP}`],
      ['trash the page', () => pg`update pages set deleted_at = now() where id = ${DIRECT}`],
      ['disable sharing for the space', () => pg`update spaces set settings = '{"sharing":{"disabled":true}}'::jsonb where id = ${SP}`],
      ['move it under a restricted parent', () => pg`update pages set parent_page_id = ${RPARENT} where id = ${DIRECT}`],
    ])('%s → the SAME outstanding token 404s at once', async (_n, change) => {
      const jwt = await mint(ATT, DIRECT);
      expect((await getFile(ATT, jwt)).statusCode).toBe(200);
      await change();
      const r = await getFile(ATT, jwt);
      expect(r.statusCode).toBe(404);
      expect(r.rawPayload.includes(BYTES)).toBe(false);
      await expectStockChecksPass(jwt, ATT);
    });

    it('a restricted page below the share root: its minted token 404s (stock checks would have served it)', async () => {
      const jwt = await mint(ATT_R, RCHILD);
      expect((await getFile(ATT_R, jwt)).statusCode).toBe(404);
      await expectStockChecksPass(jwt, ATT_R);
      expect((await withStockPredicates(() => getFile(ATT_R, jwt))).statusCode).toBe(200);
    });

    it('an expired share (the ShareRepo veto) 404s the file', async () => {
      const jwt = await mint(ATT, DIRECT);
      jest.spyOn(shareRepo, 'findById').mockResolvedValue(undefined as any);
      expect((await getFile(ATT, jwt)).statusCode).toBe(404);
    });

    it('a bad or expired JWT is still 400, before any DB read', async () => {
      const find = jest.spyOn(attachmentRepo, 'findById');
      const gate = jest.spyOn(shareService, 'getShareForPage');
      expect((await getFile(ATT, 'not-a-jwt')).statusCode).toBe(400);
      const expired = new JwtService({ secret: SECRET }).sign(
        { attachmentId: ATT, pageId: DIRECT, workspaceId: WS, type: JwtType.ATTACHMENT },
        { expiresIn: -60 },
      );
      expect((await getFile(ATT, expired)).statusCode).toBe(400);
      expect(find).not.toHaveBeenCalled();
      expect(gate).not.toHaveBeenCalled();
    });
  });

  describe('POST /search/share-search (remote PdpSearchService)', () => {
    const search = (shareId: string, ws = WS) => post('/search/share-search', { query: 'roadmap', shareId }, ws);
    const ids = (r: { json: () => any }) => r.json().items.map((i: any) => i.id).sort();

    it('a live includeSubPages share searches its unrestricted tree', async () => {
      expect(ids(await search(S_ROOT))).toEqual([ROOT, CHILD].sort());
    });

    it.each([
      ['sharing disabled for the space', S_OFF, OFFP],
      ['an archived space', S_ARCH, ARCHP],
    ])('%s → empty (control: the stock upstream search returns the page)', async (_n, shareId, pageId) => {
      expect(ids(await search(shareId))).toEqual([]);
      const stock = new SearchService(db, pageRepo, shareRepo, {} as any, pagePermissionRepo);
      const { items } = await stock.searchPage({ query: 'roadmap', shareId } as any, { workspaceId: WS });
      expect(items.map((i: any) => i.id)).toEqual([pageId]);
    });

    it('another workspace → empty', async () => {
      expect(ids(await search(S_ROOT, FWS))).toEqual([]);
    });

    it('an unknown or vetoed (expired) share → empty', async () => {
      expect(ids(await search(uuid(599)))).toEqual([]);
      jest.spyOn(shareRepo, 'findById').mockResolvedValue(undefined as any);
      expect(ids(await search(S_ROOT))).toEqual([]);
    });
  });
  describe('expiry at READ time, end to end (real PdpShareRepo, no sweeper) (#335)', () => {
    const expire = (shareId: string) =>
      pg`insert into ccc_share_expiry (share_id, expires_at) values (${shareId}, now() - interval '1 second')`;
    const transcluded = async () => {
      lastAccessibleSet = undefined;
      const refs = [{ sourcePageId: DIRECT, transclusionId: 't1' }];
      expect((await post('/shares/transclusion/lookup', { shareId: S_ROOT, references: refs })).statusCode).toBe(200);
      return [...(lastAccessibleSet ?? [])];
    };
    const searched = async (shareId: string) =>
      (await post('/search/share-search', { query: 'roadmap', shareId })).json().items.map((i: any) => i.id);

    it('one expired share denies every public path at once, while its row is still in the table', async () => {
      const jwt = await mint(ATT, DIRECT);
      // Control: every path answers while the share is live.
      expect((await post('/shares/page-info', { pageId: 'pdirect' })).statusCode).toBe(200);
      expect((await post('/shares/info', { shareId: S_DIRECT })).statusCode).toBe(200);
      expect((await post('/shares/tree', { shareId: S_DIRECT })).statusCode).toBe(200);
      expect(await seo('pdirect')).toContain(`og:title" content="${TITLE[DIRECT]}"`);
      expect((await post('/shares/for-page', { pageId: DIRECT })).json().id).toBe(S_DIRECT);
      expect(await searched(S_DIRECT)).toEqual([DIRECT]);
      expect((await getFile(ATT, jwt)).statusCode).toBe(200);
      expect(await transcluded()).toEqual([DIRECT]);

      await expire(S_DIRECT);

      expect((await post('/shares/page-info', { pageId: 'pdirect' })).statusCode).toBe(404);
      expect((await post('/shares/info', { shareId: S_DIRECT })).statusCode).toBe(404);
      expect((await post('/shares/info', { shareId: 'kdirect' })).statusCode).toBe(404); // by key too
      expect((await post('/shares/tree', { shareId: S_DIRECT })).statusCode).toBe(404);
      const html = await seo('pdirect');
      expect(html).not.toContain(TITLE[DIRECT]);
      expect(html).not.toContain('og:title');
      expect((await post('/shares/for-page', { pageId: DIRECT })).body).toBe('');
      expect(await searched(S_DIRECT)).toEqual([]);
      const file = await getFile(ATT, jwt);
      expect(file.statusCode).toBe(404);
      expect(file.rawPayload.includes(BYTES)).toBe(false);
      expect(await transcluded()).toEqual([]);
      // No sweeper ran: the dead row is still there — the denials are the read-time gate alone.
      expect((await pg`select id from shares where id = ${S_DIRECT}`).length).toBe(1);
    });

    it('an expired share ROOT hides its includeSubPages children (the veto re-reads the resolved share)', async () => {
      expect((await post('/shares/page-info', { pageId: 'pchild' })).statusCode).toBe(200);
      await expire(S_ROOT);
      expect((await post('/shares/page-info', { pageId: 'pchild' })).statusCode).toBe(404);
      expect(await seo('pchild')).not.toContain('og:title');
      expect(await searched(S_ROOT)).toEqual([]);
    });
  });
});
