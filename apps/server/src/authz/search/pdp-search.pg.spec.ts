import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PdpSearchService, SearchCandidateFilters } from './pdp-search.service';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
  createKnowledgeTables,
} from '../../service-bridge/read-model-pg.testkit';

/**
 * Real-Postgres proof of the #615 search filters (`PdpSearchService.searchAuthorized`): each filter is a predicate
 * the ENGINE applies to the candidate stream — the label exists-join only matches a PAGE label of THIS workspace,
 * the editor / parent / updated-range predicates select the right rows, a trashed page never appears — and the
 * `hasMore` peek and the on-behalf-of service leg behave over real rows. The unit twin
 * (pdp-search.authorized.spec.ts) pins the SQL text; this one proves that SQL means what it says.
 *
 * The FTS inputs are minimal but real: `tsv` holds `to_tsvector('english', title)` and `f_unaccent` is an identity
 * stand-in for Docmost's unaccent wrapper. The PDP legs are stubs (a denied set per leg). Self-skips without
 * AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG permission-aware search filters', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'pdp_search_pg_spec';
const WS = uuid(100);
const FOREIGN_WS = uuid(200);
const SPACE = uuid(50);
const OTHER_SPACE = uuid(51);
const ALICE = uuid(300);
const BOB = uuid(301);
const SA = uuid(900);

// Every page title matches the query 'roadmap'.
const ROOT = uuid(1); // top level, no label
const P1 = uuid(2); // child of ROOT, created by ALICE, last edited by BOB, page label 'road-map', updated Jan
const P2 = uuid(3); // child of ROOT, created by BOB, last edited by ALICE, updated Mar
const P3 = uuid(4); // TRASHED, would match every filter
const P4 = uuid(5); // carries a 'road-map' label of ANOTHER workspace
const P5 = uuid(6); // carries a 'road-map' label of type 'space' (not a page label)
const P6 = uuid(7); // in OTHER_SPACE (the user is not a member)
const P7 = uuid(8); // another workspace's page, same space id

const LABEL_PAGE = uuid(700);
const LABEL_FOREIGN = uuid(701);
const LABEL_SPACE_TYPE = uuid(702);

d('PdpSearchService.searchAuthorized over real rows (#615)', () => {
  let pg: postgres.Sql;
  let db: Kysely<any>;

  const build = (opts: { userDenied?: string[]; serviceDenied?: string[] } = {}) => {
    const filterAccessiblePageIds = jest.fn(async ({ pageIds }: { pageIds: string[] }) =>
      pageIds.filter((id) => !(opts.userDenied ?? []).includes(id)),
    );
    const filterResources = jest.fn(async (_s: unknown, _p: string, _t: string, ids: string[]) =>
      ids.filter((id) => !(opts.serviceDenied ?? []).includes(id)),
    );
    const service = new PdpSearchService(
      db as any,
      new PageRepo(db as any, {} as any, {} as any),
      {} as any,
      new SpaceMemberRepo(db as any, {} as any, {} as any, {} as any),
      { filterAccessiblePageIds } as any,
      { filterResources } as any,
    );
    return { service, filterAccessiblePageIds, filterResources };
  };

  const search = async (
    filters: SearchCandidateFilters,
    params: { spaceId?: string; limit?: number; offset?: number } = { spaceId: SPACE },
    opts: { serviceSubjectId?: string; userDenied?: string[]; serviceDenied?: string[] } = {},
  ) => {
    const { service } = build(opts);
    const page = await service.searchAuthorized({ query: 'roadmap', limit: 25, ...params } as any, filters, {
      userId: ALICE,
      workspaceId: WS,
      serviceSubjectId: opts.serviceSubjectId,
    });
    return { ids: page.items.map((r: any) => r.id).sort(), hasMore: page.hasMore, items: page.items };
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(pg);
    await createReadModelTables(pg);
    await createKnowledgeTables(pg);
    await pg`alter table pages add column tsv tsvector, add column text_content text`;
    await pg`create table group_users (user_id uuid not null, group_id uuid not null)`;
    await pg`create function f_unaccent(text) returns text language sql immutable as $$ select $1 $$`;

    await pg`insert into spaces (id, name, slug, workspace_id) values
      (${SPACE}, 'Eng', 'eng', ${WS}), (${OTHER_SPACE}, 'Ops', 'ops', ${WS})`;
    await pg`insert into space_members (user_id, space_id, role) values (${ALICE}, ${SPACE}, 'reader')`;

    const page = (
      id: string,
      o: { parent?: string; creator?: string; editor?: string; updated: string; ws?: string; space?: string; deleted?: boolean },
    ) => pg`
      insert into pages (id, slug_id, title, space_id, parent_page_id, workspace_id, creator_id, last_updated_by_id,
                         updated_at, deleted_at, tsv, text_content)
      values (${id}, ${'s' + id.slice(-4)}, ${'Roadmap ' + id.slice(-4)}, ${o.space ?? SPACE}, ${o.parent ?? null},
              ${o.ws ?? WS}, ${o.creator ?? ALICE}, ${o.editor ?? ALICE}, ${o.updated}::timestamptz,
              ${o.deleted ? new Date('2026-04-01T00:00:00Z') : null}, to_tsvector('english', 'Roadmap'), 'Roadmap body')`;
    await page(ROOT, { updated: '2026-02-01T00:00:00Z' });
    await page(P1, { parent: ROOT, creator: ALICE, editor: BOB, updated: '2026-01-15T00:00:00Z' });
    await page(P2, { parent: ROOT, creator: BOB, editor: ALICE, updated: '2026-03-01T00:00:00Z' });
    await page(P3, { parent: ROOT, creator: ALICE, editor: BOB, updated: '2026-01-15T00:00:00Z', deleted: true });
    await page(P4, { updated: '2026-01-15T00:00:00Z' });
    await page(P5, { updated: '2026-01-15T00:00:00Z' });
    await page(P6, { space: OTHER_SPACE, updated: '2026-01-15T00:00:00Z' });
    await page(P7, { ws: FOREIGN_WS, updated: '2026-01-15T00:00:00Z' });

    await pg`insert into labels (id, name, type, workspace_id) values
      (${LABEL_PAGE}, 'road-map', 'page', ${WS}),
      (${LABEL_FOREIGN}, 'road-map', 'page', ${FOREIGN_WS}),
      (${LABEL_SPACE_TYPE}, 'road-map', 'space', ${WS})`;
    await pg`insert into page_labels (page_id, label_id) values
      (${P1}, ${LABEL_PAGE}), (${P3}, ${LABEL_PAGE}), (${P4}, ${LABEL_FOREIGN}), (${P5}, ${LABEL_SPACE_TYPE})`;
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('no filter: every live page of the space in this workspace (never the trashed, other-space or foreign page)', async () => {
    expect((await search({})).ids).toEqual([ROOT, P1, P2, P4, P5].sort());
  });

  it('labelName matches only a PAGE label of THIS workspace (normalized first), never a trashed page', async () => {
    expect((await search({ labelName: 'road-map' })).ids).toEqual([P1]);
    expect((await search({ labelName: '  Road Map ' })).ids).toEqual([P1]);
    expect((await search({ labelName: 'nothing-here' })).ids).toEqual([]);
  });

  it('lastUpdatedById / creatorId / parentPageId select exactly their rows', async () => {
    expect((await search({ lastUpdatedById: BOB })).ids).toEqual([P1]);
    expect((await search({ creatorId: BOB })).ids).toEqual([P2]);
    expect((await search({ parentPageId: ROOT })).ids).toEqual([P1, P2].sort());
  });

  it('the updated range is [since, until) over real timestamps', async () => {
    expect((await search({ updatedSince: '2026-02-01T00:00:00Z' })).ids).toEqual([ROOT, P2].sort());
    expect((await search({ updatedUntil: '2026-02-01T00:00:00Z' })).ids).toEqual([P1, P4, P5].sort());
    expect(
      (await search({ updatedSince: '2026-01-15T00:00:00Z', updatedUntil: '2026-01-15T00:00:00.001Z' })).ids,
    ).toEqual([P1, P4, P5].sort());
  });

  it('filters compose (AND), and a Postgres-invalid bound is a 400, not a 500 at the cast', async () => {
    expect((await search({ parentPageId: ROOT, lastUpdatedById: BOB, labelName: 'road-map' })).ids).toEqual([P1]);
    await expect(search({ updatedSince: '2026' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('without a spaceId the stream is the user\'s member spaces (OTHER_SPACE never enters)', async () => {
    expect((await search({}, {})).ids).toEqual([ROOT, P1, P2, P4, P5].sort());
  });

  it('hasMore peeks one authorized row past the page', async () => {
    const all = [ROOT, P1, P2, P4, P5];
    const first = await search({}, { spaceId: SPACE, limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.hasMore).toBe(true);
    const last = await search({}, { spaceId: SPACE, limit: 4, offset: 4 });
    expect(last.items).toHaveLength(1);
    expect(last.hasMore).toBe(false);
    expect([...first.ids, ...last.ids].sort()).toEqual(all.sort());
    // The last authorized row is denied to the user → the peek finds nothing: no "more".
    const denied = await search({}, { spaceId: SPACE, limit: 4 }, { userDenied: [last.ids[0]] });
    expect(denied.hasMore).toBe(false);
  });

  it('the service leg: a page the service account cannot see is skipped and hasMore is service ∩ user', async () => {
    const out = await search({ parentPageId: ROOT }, { spaceId: SPACE, limit: 1 }, { serviceSubjectId: SA, serviceDenied: [P1] });
    expect(out.ids).toEqual([P2]);
    expect(out.hasMore).toBe(false);
  });
});
