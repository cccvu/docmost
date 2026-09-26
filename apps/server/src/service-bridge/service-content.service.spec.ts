import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceContentService } from './service-content.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

const workspaces = () => ({ resolveDefaultWorkspaceId: jest.fn(async () => 'ws1') }) as any;
const make = (respond: (q: SpyQuery) => unknown[]) => {
  const spy = spyKysely(respond);
  return { svc: new ServiceContentService(spy.db, workspaces()), spy };
};
const q = (s: string) => s.toLowerCase();

const pageRow = (id: string) => ({
  id,
  slugId: `slug-${id}`,
  title: id,
  icon: null,
  spaceId: 'sp1',
  parentPageId: null,
  position: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

describe('ServiceContentService — privileged data plane (trusts the platform PDP filter)', () => {
  it('has NO authorization collaborator: it takes only (db, workspaces)', () => {
    // Structural proof that this endpoint is not a second authorization gate — there is no PDP/decision
    // dependency it could consult. Security rests entirely on the platform passing an authorized id set.
    expect(ServiceContentService.length).toBe(2);
  });

  it('returns metadata for EXACTLY the supplied ids, unfiltered, binding the id set to the query', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    const { svc, spy } = make(() => ids.map(pageRow));

    const res = await svc.listPagesByIds({ ids, limit: 10 } as any);

    // Every row the DB returns for the authorized id set is passed straight through — the fork does NOT
    // re-authorize or drop any of them; the ids ARE the belt.
    expect(res.items.map((i) => i.id)).toEqual(ids);
    const call = spy.calls[0];
    expect(q(call.sql)).toContain('id = any(');
    expect(call.parameters).toContainEqual(ids); // the id set bound as ONE array parameter
  });

  // Confidentiality is enforced by two predicates the trust model depends on: single-tenant scoping and
  // soft-delete exclusion. The deleted real-Postgres contract test used to assert these end to end; pin them
  // on the compiled SQL here so a future edit that drops either predicate fails CI instead of silently
  // leaking trashed or cross-workspace content into /v1. (Real-Postgres re-homing is tracked in issue 174.)
  it('scopes both list queries to the workspace AND excludes soft-deleted rows', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111'];
    const pages = make(() => []);
    await pages.svc.listPagesByIds({ ids, limit: 10 } as any);
    const pageSql = q(pages.spy.calls[0].sql);
    expect(pageSql).toContain('workspace_id =');
    expect(pageSql).toContain('deleted_at is null');

    const spaces = make(() => []);
    await spaces.svc.listSpacesByIds({ ids, limit: 10 } as any);
    const spaceSql = q(spaces.spy.calls[0].sql);
    expect(spaceSql).toContain('workspace_id =');
    expect(spaceSql).toContain('deleted_at is null');
  });

  it('listSpacesByIds returns the supplied spaces and honours the keyset cursor', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111'];
    const { svc, spy } = make(() => [
      {
        id: ids[0],
        name: 's',
        slug: 'slug',
        description: null,
        visibility: 'open',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    const res = await svc.listSpacesByIds({
      ids,
      before: { updatedAt: '2026-01-01T00:00:00.000Z', id: 'x' },
      limit: 5,
    } as any);
    expect(res.items.map((i) => i.id)).toEqual(ids);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain("date_trunc('milliseconds', updated_at)");
    expect(sql).toContain('order by');
  });

  it('resolvePageSpace excludes deleted pages by default but includes them when asked', async () => {
    const pageId = '55555555-5555-5555-5555-555555555555';
    const active = make(() => [{ spaceId: 'sp1' }]);
    expect(await active.svc.resolvePageSpace({ pageId } as any)).toEqual({ pageId, spaceId: 'sp1' });
    expect(q(active.spy.calls[0].sql)).toContain('deleted_at is null');

    const anyState = make(() => [{ spaceId: 'sp1' }]);
    await anyState.svc.resolvePageSpace({ pageId, includeDeleted: true } as any);
    expect(q(anyState.spy.calls[0].sql)).not.toContain('deleted_at is null');

    const missing = make(() => []);
    await expect(missing.svc.resolvePageSpace({ pageId } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('listPagePermissions returns the ACL grants joined workspace-scoped', async () => {
    const pageId = '66666666-6666-6666-6666-666666666666';
    const { svc, spy } = make(() => [
      { id: 'perm1', userId: 'u1', groupId: null, role: 'reader', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    const res = await svc.listPagePermissions(pageId);
    expect(res.items).toEqual([
      { id: 'perm1', userId: 'u1', groupId: null, role: 'reader', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('page_permissions');
    expect(sql).toContain('join page_access');
    expect(sql).toContain('workspace_id ='); // ACL read is tenant-scoped too
  });

  it('applies the space filter and the keyset cursor bound when given', async () => {
    const { svc, spy } = make(() => []);
    await svc.listPagesByIds({
      ids: ['11111111-1111-1111-1111-111111111111'],
      spaceId: '33333333-3333-3333-3333-333333333333',
      before: { updatedAt: '2026-01-01T00:00:00.000Z', id: 'x' },
      limit: 5,
    } as any);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('space_id ='); // pages scoped to one space
    expect(sql).toContain("date_trunc('milliseconds', updated_at)"); // keyset cursor predicate + order
    expect(sql).toContain('order by');
    expect(sql).toContain('limit'); // fetches limit+1 for hasMore detection
  });

  it('getSpace 404s an unknown space', async () => {
    const { svc } = make(() => []);
    await expect(
      svc.getSpace('44444444-4444-4444-4444-444444444444'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ServiceContentService — allowlisted filters + sort pushdown (backward-compatible)', () => {
  const IDS = ['11111111-1111-1111-1111-111111111111'];

  it('the default path (no sort) emits the exact legacy keyset SQL', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({ ids: IDS, limit: 10 } as any);
    const sql = q(spy.calls[0].sql);
    // The backward-compat invariant: no sort → millisecond-truncated updated_at desc, id::text desc.
    expect(sql).toContain("date_trunc('milliseconds', updated_at) desc");
    expect(sql).toContain('id::text desc');
    expect(sql).not.toContain('coalesce(');
  });

  it('pushes the allowlisted page filters into the WHERE (bound params, ilike substring)', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({
      ids: IDS,
      parentPageId: '22222222-2222-2222-2222-222222222222',
      titleContains: 'road%map',
      creatorId: '33333333-3333-3333-3333-333333333333',
      updatedSince: '2026-01-01T00:00:00.000Z',
      updatedUntil: '2026-02-01T00:00:00.000Z',
      limit: 10,
    } as any);
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain('parent_page_id =');
    expect(sql).toContain('title ilike');
    expect(sql).toContain('creator_id =');
    expect(sql).toContain('updated_at >=');
    expect(sql).toContain('updated_at <');
    // The ilike metacharacter in the user input is escaped so it matches literally.
    expect(call.parameters).toContainEqual('%road\\%map%');
  });

  it('pushes the allowlisted space filters into the WHERE', async () => {
    const { spy, svc } = make(() => []);
    await svc.listSpacesByIds({
      ids: IDS,
      nameContains: 'eng',
      createdSince: '2026-01-01T00:00:00.000Z',
      createdUntil: '2026-02-01T00:00:00.000Z',
      limit: 10,
    } as any);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('name ilike');
    expect(sql).toContain('created_at >=');
    expect(sql).toContain('created_at <');
  });

  it('sort=createdAt desc emits a created_at keyset (ms-truncated) instead of updated_at', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({
      ids: IDS,
      sort: { field: 'createdAt', direction: 'desc' },
      before: { value: '2026-01-05T00:00:00.000Z', id: 'x' },
      limit: 10,
    } as any);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain("date_trunc('milliseconds', created_at)");
    expect(sql).toContain('order by');
  });

  it('sort=title asc (pages) coalesces null titles and uses a > keyset bound', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({
      ids: IDS,
      sort: { field: 'title', direction: 'asc' },
      before: { value: 'Roadmap', id: 'x' },
      limit: 10,
    } as any);
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain("coalesce(title, '')");
    expect(sql).toContain('asc');
    expect(sql).toContain('::text'); // text-typed keyset bound
    expect(call.parameters).toContainEqual('Roadmap');
  });

  it('sort=name (spaces) coalesces the name column', async () => {
    const { spy, svc } = make(() => []);
    await svc.listSpacesByIds({
      ids: IDS,
      sort: { field: 'name', direction: 'asc' },
      limit: 10,
    } as any);
    expect(q(spy.calls[0].sql)).toContain("coalesce(name, '')");
  });

  it('rejects a cross-resource sort field (name on pages, title on spaces) with 400', async () => {
    const pages = make(() => []);
    await expect(
      pages.svc.listPagesByIds({ ids: IDS, sort: { field: 'name', direction: 'asc' }, limit: 10 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    const spaces = make(() => []);
    await expect(
      spaces.svc.listSpacesByIds({ ids: IDS, sort: { field: 'title', direction: 'asc' }, limit: 10 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a text-sort cursor missing its bound value is a 400 (not a 500 at the cast)', async () => {
    const { svc } = make(() => []);
    await expect(
      svc.listPagesByIds({
        ids: IDS,
        sort: { field: 'title', direction: 'asc' },
        before: { id: 'x' }, // no value, no updatedAt
        limit: 10,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a text sort does NOT fall back to a legacy timestamp cursor (400, never wrong-boundary pagination)', async () => {
    const { svc } = make(() => []);
    // A title sort with only `updatedAt` (a timestamp) and no `value` must 400 — falling back would compare a
    // timestamp string against titles and paginate wrong (Correctness #2).
    await expect(
      svc.listPagesByIds({
        ids: IDS,
        sort: { field: 'title', direction: 'asc' },
        before: { updatedAt: '2026-01-01T00:00:00.000Z', id: 'x' },
        limit: 10,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a timestamp-sort cursor whose bound is not a valid instant is a 400 (not a 500 at the ::timestamptz cast)', async () => {
    const { svc } = make(() => []);
    await expect(
      svc.listPagesByIds({
        ids: IDS,
        sort: { field: 'updatedAt', direction: 'desc' },
        before: { value: '2026', id: 'x' }, // Date.parse-lenient but PG-invalid
        limit: 10,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ServiceContentService.listPagePermissions — opt-in keyset paging (backward-compatible)', () => {
  const PAGE = '66666666-6666-6666-6666-666666666666';

  it('unpaged (no limit) keeps the legacy query: pp.created_at asc, no keyset, no limit', async () => {
    const { svc, spy } = make(() => []);
    await svc.listPagePermissions(PAGE);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('order by pp.created_at asc');
    expect(sql).not.toContain('date_trunc');
    expect(sql).not.toContain('limit');
  });

  it('paged uses the ms-truncated id-tiebroken ascending keyset + limit+1', async () => {
    const { svc, spy } = make(() => []);
    await svc.listPagePermissions(PAGE, {
      limit: 10,
      before: { createdAt: '2026-01-01T00:00:00.000Z', id: 'perm-3' },
    });
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain("date_trunc('milliseconds', pp.created_at) asc");
    expect(sql).toContain('pp.id::text asc');
    expect(sql).toContain('> ('); // ascending keyset bound
    expect(call.parameters).toContainEqual(11); // limit + 1
  });
});

describe('ServiceContentService — #615 page-list filters, projection and position sort', () => {
  const IDS = ['11111111-1111-1111-1111-111111111111'];
  const U = '22222222-2222-2222-2222-222222222222';

  it('the default path keeps its legacy shape and adds only the workspace-pinned creator/editor projection', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({ ids: IDS, limit: 10 } as any);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain("order by date_trunc('milliseconds', updated_at) desc, id::text desc");
    expect(sql).not.toContain('with recursive');
    expect(sql).toContain('creator_id, last_updated_by_id');
    expect(sql).toContain('u.id = pages.creator_id and u.workspace_id = pages.workspace_id');
    expect(sql).toContain('u.id = pages.last_updated_by_id and u.workspace_id = pages.workspace_id');
  });

  it('maps the projection straight through (ids and names, null when absent)', async () => {
    const { svc } = make(() => [
      { ...pageRow(IDS[0]), creatorId: U, creatorName: 'Alice', lastUpdatedById: null, lastUpdatedByName: null },
    ]);
    const [item] = (await svc.listPagesByIds({ ids: IDS, limit: 10 } as any)).items;
    expect(item).toMatchObject({ creatorId: U, creatorName: 'Alice', lastUpdatedById: null, lastUpdatedByName: null });
  });

  it('pushes lastUpdatedById, the created range, topLevel, links and the (normalized) label into the WHERE', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({
      ids: IDS,
      lastUpdatedById: U,
      createdSince: '2026-01-01T00:00:00.000Z',
      createdUntil: '2026-02-01T00:00:00.000Z',
      topLevel: true,
      linksTo: U,
      labelName: '  Road Map ',
      limit: 10,
    } as any);
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain('last_updated_by_id =');
    expect(sql).toContain('created_at >=');
    expect(sql).toContain('created_at <');
    expect(sql).toContain('parent_page_id is null');
    expect(sql).toContain('select b.source_page_id from backlinks b');
    expect(sql).toContain("l.type = 'page'");
    expect(sql).toContain('pl.page_id = pages.id and l.workspace_id =');
    expect(call.parameters).toContainEqual('road-map');
  });

  it('topLevel=false selects pages that have a parent; linkedFrom follows outgoing links', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({ ids: IDS, topLevel: false, linkedFrom: U, limit: 10 } as any);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('parent_page_id is not null');
    expect(sql).toContain('select b.target_page_id from backlinks b');
  });

  it('descendantOf walks a depth-bounded CTE through ids + live + workspace only (default depth 3)', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({ ids: IDS, descendantOf: U, limit: 10 } as any);
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain('with recursive descendants');
    expect(sql).toContain('id in (select d.id from descendants d)');
    // Both the seed and the recursive step are pinned to the authorized, live, in-workspace rows.
    expect(sql.match(/c\.deleted_at is null and c\.id = any\(/g)).toHaveLength(2);
    expect(call.parameters).toContainEqual(3);
  });

  it.each([
    [{ topLevel: true, parentPageId: '33333333-3333-3333-3333-333333333333' }],
    [{ linksTo: '33333333-3333-3333-3333-333333333333', linkedFrom: '33333333-3333-3333-3333-333333333333' }],
    [{ descendantOf: '33333333-3333-3333-3333-333333333333', parentPageId: '33333333-3333-3333-3333-333333333333' }],
    [{ descendantOf: '33333333-3333-3333-3333-333333333333', topLevel: false }],
    [{ descendantOf: '33333333-3333-3333-3333-333333333333', linksTo: '33333333-3333-3333-3333-333333333333' }],
    [{ descendantOf: '33333333-3333-3333-3333-333333333333', linkedFrom: '33333333-3333-3333-3333-333333333333' }],
    [{ maxDepth: 2 }],
    [{ updatedSince: '2026' }],
    [{ createdUntil: '2026' }],
  ])('rejects %j with a 400 before any query', async (extra) => {
    const { spy, svc } = make(() => []);
    await expect(svc.listPagesByIds({ ids: IDS, limit: 10, ...extra } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(spy.calls).toHaveLength(0);
  });

  it('sort=position orders by coalesce(position, "~") under the C collation and bounds the keyset the same way', async () => {
    const { spy, svc } = make(() => []);
    await svc.listPagesByIds({
      ids: IDS,
      parentPageId: U,
      sort: { field: 'position', direction: 'asc' },
      before: { value: 'a0', id: 'x' },
      limit: 10,
    } as any);
    const call = spy.calls[0];
    const sql = q(call.sql);
    expect(sql).toContain(`order by coalesce(position, '~') collate "c" asc, id::text asc`);
    expect(sql).toContain(`(coalesce(position, '~') collate "c", id::text) > ($`);
    expect(sql).toContain('::text collate "c"');
    expect(call.parameters).toContainEqual('a0');
  });

  it('position is pages-only (a spaces position sort is a 400)', async () => {
    const { svc } = make(() => []);
    await expect(
      svc.listSpacesByIds({ ids: IDS, sort: { field: 'position', direction: 'asc' }, limit: 10 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ServiceContentService — #615 ancestors, labels, activity, comment policy', () => {
  const PAGE = '44444444-4444-4444-4444-444444444444';

  it('ancestors: 404 unless the page is live in the workspace; never returns the page itself', async () => {
    const missing = make(() => []);
    await expect(missing.svc.pageAncestors({ pageId: PAGE })).rejects.toBeInstanceOf(NotFoundException);
    expect(q(missing.spy.calls[0].sql)).toContain('deleted_at is null');

    const { svc } = make((c) =>
      q(c.sql).includes('with recursive anc')
        ? [
            { id: PAGE, parentPageId: 'p1', depth: 0, restricted: true },
            { id: 'p1', parentPageId: null, depth: 1, restricted: true },
          ]
        : [{ id: PAGE }],
    );
    // The walk's restriction facts are never part of the answer.
    expect(await svc.pageAncestors({ pageId: PAGE })).toEqual({ ancestorIds: ['p1'], complete: true });
  });

  it('labels: ids = [] answers [] without a query; otherwise pinned to ids + live + workspace + page type', async () => {
    const empty = make(() => []);
    expect(await empty.svc.listLabels({ ids: [], limit: 10 } as any)).toEqual({ items: [] });
    expect(empty.spy.calls).toHaveLength(0);

    const { svc, spy } = make(() => [{ name: 'road-map', pageCount: '2' }]);
    const res = await svc.listLabels({ ids: [PAGE], nameContains: 'Road_Map', before: { name: 'a' }, limit: 5 } as any);
    expect(res.items).toEqual([{ name: 'road-map', pageCount: 2 }]);
    const call = spy.calls[0];
    const sql = q(call.sql);
    for (const pin of ['l.workspace_id =', "l.type = 'page'", 'p.workspace_id =', 'p.deleted_at is null', 'p.id = any(']) {
      expect(sql).toContain(pin);
    }
    expect(sql).toContain('order by l.name collate "c" asc');
    expect(call.parameters).toContainEqual('%road\\_map%'); // normalized, then LIKE-escaped
    expect(call.parameters).toContainEqual(6); // limit + 1
  });

  it('activity: one branch per requested source, each pinned to the authorized pages and the workspace', async () => {
    const { svc, spy } = make(() => []);
    await svc.listActivity({ ids: [PAGE], since: '2026-01-01T00:00:00.000Z', limit: 10 } as any);
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('p.id = any(');
    expect(sql).toContain('p.workspace_id =');
    for (const src of ['page_history h join ap', 'comments c join ap', 'attachments f join ap', 'audit a join ap']) {
      expect(sql).toContain(src);
    }
    for (const pin of ['h.workspace_id =', 'c.workspace_id =', 'f.workspace_id =', 'a.workspace_id =']) {
      expect(sql).toContain(pin);
    }
    expect(sql).toContain('order by e.occurred_at desc, e.key collate "c" desc');

    const narrow = make(() => []);
    await narrow.svc.listActivity({ ids: [PAGE], since: '2026-01-01T00:00:00.000Z', types: ['comment.created'], limit: 10 } as any);
    const only = q(narrow.spy.calls[0].sql);
    expect(only).toContain('comments c join ap');
    expect(only).not.toContain('page_history');
    expect(only).not.toContain('audit a');
  });

  it('activity: ids = [] answers [] without a query; a malformed instant is a 400', async () => {
    const empty = make(() => []);
    expect(await empty.svc.listActivity({ ids: [], since: '2026-01-01T00:00:00.000Z', limit: 10 } as any)).toEqual({ items: [] });
    expect(empty.spy.calls).toHaveLength(0);
    await expect(
      empty.svc.listActivity({ ids: [PAGE], since: '2026', limit: 10 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('comment policy: workspace-scoped read of settings.comments.allowViewerComments; 404 when absent', async () => {
    const missing = make(() => []);
    await expect(missing.svc.spaceCommentPolicy({ spaceId: PAGE })).rejects.toBeInstanceOf(NotFoundException);
    const sql = q(missing.spy.calls[0].sql);
    expect(sql).toContain('workspace_id =');
    expect(sql).toContain(`settings->'comments'->>'allowviewercomments'`);

    const on = make(() => [{ allowViewerComments: true }]);
    expect(await on.svc.spaceCommentPolicy({ spaceId: PAGE })).toEqual({ allowViewerComments: true });
  });
});
