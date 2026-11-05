import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PdpSearchService, SearchCandidateFilters, SearchLimits } from './pdp-search.service';
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

  const build = (
    opts: {
      userDenied?: string[];
      serviceDenied?: string[];
      /** Runs inside the user-leg PDP call — i.e. BETWEEN the candidate statement and the hydrate. */
      duringGate?: () => Promise<void>;
      limits?: Partial<SearchLimits>;
    } = {},
  ) => {
    const pdp = {
      tryFilterResources: jest.fn(async (subject: any, _p: string, _t: string, ids: string[]) => {
        const service = subject?.subjectType === 'service';
        if (!service && opts.duringGate) await opts.duringGate();
        const denied = (service ? opts.serviceDenied : opts.userDenied) ?? [];
        return ids.filter((id) => !denied.includes(id));
      }),
    };
    const service = new PdpSearchService(
      db as any,
      new PageRepo(db as any, {} as any, {} as any),
      {} as any,
      new SpaceMemberRepo(db as any, {} as any, {} as any, {} as any),
      {} as any,
      pdp,
      undefined,
      opts.limits,
    );
    return { service, pdp };
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

  // ---- #696: one candidate statement, a hydrate of the authorized slice, statement timeouts ----------------------

  describe('#696 hydrate and timeouts over real rows', () => {
    // A space of its own (no member: every search names it), so the #615 cases above never see these pages.
    const HSPACE = uuid(60);
    // Rank order H1 > H2 > H4 > H3 is the REVERSE of id order and of insertion (heap) order, so a hydrate that kept
    // the SQL row order instead of the candidate order would come back reversed.
    const H1 = uuid(44); // 'kestrel' ×4 → the highest rank
    const H2 = uuid(43); // ×3
    const H4 = uuid(42); // ×2, trashed BETWEEN the gate and the hydrate in one case
    const H3 = uuid(41); // ×1, its match only past the 64 KiB headline input cap
    const deep = 'filler '.repeat(10_000); // 70,000 chars

    beforeAll(async () => {
      await pg`insert into spaces (id, name, slug, workspace_id) values (${HSPACE}, 'Birds', 'birds', ${WS})`;
      const page = (id: string, text: string) => pg`
        insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, tsv, text_content)
        values (${id}, ${'h' + id.slice(-4)}, ${'Bird ' + id.slice(-4)}, ${HSPACE}, ${WS}, ${ALICE},
                to_tsvector('english', ${text}), ${text})`;
      await page(H3, deep + ' kestrel');
      await page(H4, 'a kestrel, a kestrel');
      await page(H2, 'the kestrel hovers; a kestrel nests by a kestrel');
      await page(H1, 'kestrel\nkestrel and\r\nmore kestrel  in a long\n\nbody about falcons and a kestrel');
    });

    const hsearch = (b: ReturnType<typeof build>, params: object = {}) =>
      b.service.searchAuthorized({ query: 'kestrel', spaceId: HSPACE, limit: 25, ...params } as any, {}, {
        userId: ALICE,
        workspaceId: WS,
      });

    it('returns the hydrated page in rank order, with the native columns, the space and a normalized headline', async () => {
      const { items, hasMore } = await hsearch(build());
      expect(items.map((r: any) => r.id)).toEqual([H1, H2, H4, H3]);
      expect(hasMore).toBe(false);
      const ranks = items.map((r: any) => r.rank);
      expect(new Set(ranks).size).toBe(4);
      expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
      const top: any = items[0];
      expect(top).toMatchObject({ slugId: 'h0044', title: 'Bird 0044', creatorId: ALICE, parentPageId: null, icon: null });
      expect(top.space).toEqual({ id: HSPACE, name: 'Birds', slug: 'birds' });
      expect(top.createdAt).toBeInstanceOf(Date);
      expect(top.highlight).toContain('<b>kestrel</b>');
      expect(top.highlight).not.toMatch(/[\r\n]|\s{2}/);
    });

    it('the headline reads at most 64 KiB of text: a match past the cap gets the leading snippet, not a highlight', async () => {
      const { items } = await hsearch(build());
      const h3: any = items.find((r: any) => r.id === H3);
      expect(h3.highlight).not.toContain('<b>');
      expect(h3.highlight).toMatch(/^filler filler/);
      // Control: the same row's match IS found by the candidate statement (tsv), only the headline is capped.
      expect(items.map((r: any) => r.id)).toContain(H3);
    });

    it('a page trashed BETWEEN the gate and the hydrate is dropped — the page shrinks, nothing ungated fills it', async () => {
      const b = build({
        duringGate: async () => {
          await pg`update pages set deleted_at = now() where id = ${H4}`;
        },
      });
      try {
        const { items } = await hsearch(b, { limit: 4 });
        expect(items.map((r: any) => r.id)).toEqual([H1, H2, H3]);
        expect(b.pdp.tryFilterResources).toHaveBeenCalledTimes(1); // gated once, before the trash
      } finally {
        await pg`update pages set deleted_at = null where id = ${H4}`;
      }
    });

    it('a statement past its statement_timeout is SQLSTATE 57014 → 503 engine_busy (and the next search works)', async () => {
      // f_unaccent sleeping 300 ms makes the candidate statement outlive a 100 ms statement_timeout.
      await pg`create or replace function f_unaccent(text) returns text language plpgsql immutable as
        $$ begin perform pg_sleep(0.3); return $1; end $$`;
      const slow = build({ limits: { statementTimeoutMs: 100, minStatementMs: 1 } });
      const warn = jest.spyOn((slow.service as any).logger, 'warn').mockImplementation();
      try {
        const err: any = await hsearch(slow).catch((e) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect(err.getResponse()).toMatchObject({ code: 'engine_busy' });
        expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/SEARCH_SHED reason=sqlstate code=57014/);
        expect(slow.pdp.tryFilterResources).not.toHaveBeenCalled();
      } finally {
        await pg`create or replace function f_unaccent(text) returns text language sql immutable as $$ select $1 $$`;
      }
      // The SET LOCAL ended with its transaction: the pooled connections carry no leftover timeout.
      expect((await hsearch(build())).items).toHaveLength(4);
      const settings = await Promise.all([1, 2, 3, 4].map(() => pg`show statement_timeout`));
      expect(settings.map((r) => r[0].statement_timeout)).toEqual(['0', '0', '0', '0']);
    });
  });
});
