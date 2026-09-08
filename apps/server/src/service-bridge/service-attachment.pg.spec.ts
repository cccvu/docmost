import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
import { ServiceAttachmentService } from './service-attachment.service';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
} from './read-model-pg.testkit';

/**
 * Real-Postgres proof for the attachment read ops (PR #22 review, Testing lens). The unit spec only
 * string-matches the compiled SQL via the Kysely spy, so a raw-`sql` column/table typo in `resolvePage` /
 * `listByPage` ships green (ts-jest does not type-check raw `sql` templates). This runs both queries on the
 * engine and also walks the opt-in paging keyset across a shared-millisecond tie (no skip / no duplicate).
 *
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG attachment read gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'service_attachment_pg_spec';
const DEFAULT_WS = uuid(100);
const FOREIGN_WS = uuid(200);
const PAGE = uuid(50);
const OTHER_PAGE = uuid(51);
const SPACE = uuid(60);

d('ServiceAttachmentService on real Postgres (resolve + list + paging keyset)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceAttachmentService;

  const insertAttachment = (
    id: string,
    opts: {
      pageId?: string | null;
      spaceId?: string | null;
      workspaceId?: string;
      type?: string;
      deleted?: boolean;
      createdAtIso?: string;
      fileSize?: number | null;
    } = {},
  ) => {
    const ts = opts.createdAtIso ? pg`${opts.createdAtIso}::timestamptz` : pg`now()`;
    return pg`
      insert into attachments (id, file_name, file_ext, file_path, mime_type, file_size, type, page_id, space_id, creator_id, workspace_id, created_at, updated_at, deleted_at)
      values (${id}, ${'f-' + id.slice(-3) + '.pdf'}, 'pdf', ${'/att/' + id}, 'application/pdf',
              ${opts.fileSize === undefined ? 1024 : opts.fileSize}, ${opts.type ?? 'file'},
              ${opts.pageId === undefined ? PAGE : opts.pageId}, ${opts.spaceId === undefined ? SPACE : opts.spaceId},
              ${uuid(70)}, ${opts.workspaceId ?? DEFAULT_WS}, ${ts}, ${ts}, ${opts.deleted ? pg`now()` : null})`;
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    // The attachments table (subset faithful to the columns resolvePage/listByPage touch; page_id/space_id are
    // nullable with no FK, exactly like the Docmost migration).
    await pg`
      create table attachments (
        id uuid primary key, file_name varchar not null, file_ext varchar not null, file_path varchar not null,
        mime_type varchar, file_size int8, type varchar, page_id uuid, space_id uuid, creator_id uuid,
        workspace_id uuid not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz
      )`;
    svc = new ServiceAttachmentService(db as any, fakeWorkspaceResolver(DEFAULT_WS));

    // resolve fixtures (uuid(1) lives on OTHER_PAGE so it does not pollute PAGE's list assertions below)
    await insertAttachment(uuid(1), { pageId: OTHER_PAGE, spaceId: SPACE }); // page attachment
    await insertAttachment(uuid(2), { pageId: null, spaceId: null, type: 'avatar' }); // non-page (null page/space)
    await insertAttachment(uuid(3), { workspaceId: FOREIGN_WS }); // cross-tenant
    await insertAttachment(uuid(4), { deleted: true }); // soft-deleted

    // list fixtures on PAGE: a non-file (excluded) + 4 file rows with controlled created_at (uuid 12/13 tie)
    await insertAttachment(uuid(10), { pageId: PAGE, type: 'chat' }); // not type=file → excluded
    await insertAttachment(uuid(11), { pageId: PAGE, createdAtIso: '2026-01-01T00:00:00.000Z' });
    await insertAttachment(uuid(12), { pageId: PAGE, createdAtIso: '2026-01-01T00:00:01.000Z' });
    await insertAttachment(uuid(13), { pageId: PAGE, createdAtIso: '2026-01-01T00:00:01.000Z' }); // tie w/ 12
    await insertAttachment(uuid(14), { pageId: PAGE, createdAtIso: '2026-01-01T00:00:02.000Z' });
    await insertAttachment(uuid(20), { pageId: OTHER_PAGE }); // different page → excluded from PAGE's list
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  describe('resolvePage', () => {
    it('returns the owning page + space for a page attachment', async () => {
      await expect(svc.resolvePage(uuid(1))).resolves.toEqual({ attachmentId: uuid(1), pageId: OTHER_PAGE, spaceId: SPACE });
    });
    it('returns null page/space for a non-page attachment (avatar)', async () => {
      await expect(svc.resolvePage(uuid(2))).resolves.toEqual({ attachmentId: uuid(2), pageId: null, spaceId: null });
    });
    it('404s a cross-workspace, soft-deleted, or unknown attachment (engine-enforced)', async () => {
      await expect(svc.resolvePage(uuid(3))).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.resolvePage(uuid(4))).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.resolvePage(uuid(999))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listByPage', () => {
    it('returns only type=file rows for the page, workspace-scoped, oldest first, numeric fileSize', async () => {
      const { items } = await svc.listByPage(PAGE);
      // uuid(10) is type=chat → excluded; uuid(20) is a different page → excluded.
      expect(items.map((a) => a.id)).toEqual([uuid(11), uuid(12), uuid(13), uuid(14)]);
      expect(items.every((a) => a.type === 'file')).toBe(true);
      expect(typeof items[0].fileSize).toBe('number');
    });

    it('unpaged returns ALL file attachments (backward-compatible default)', async () => {
      const { items } = await svc.listByPage(PAGE);
      expect(items).toHaveLength(4);
    });

    it('pages the keyset ascending across a same-ms tie with no skip and no duplicate', async () => {
      const walk: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const { items } = await svc.listByPage(PAGE, { limit: 2, before: cursor });
        const kept = items.slice(0, 2);
        walk.push(...kept.map((a) => a.id));
        if (items.length <= 2) break; // no limit+1 overflow → last page
        const last = kept[kept.length - 1];
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      // uuid(12)/uuid(13) share a truncated ms; the ascending id::text tiebreak puts 13 on the correct page.
      expect(walk).toEqual([uuid(11), uuid(12), uuid(13), uuid(14)]);
      expect(new Set(walk).size).toBe(walk.length);
    });
  });
});
