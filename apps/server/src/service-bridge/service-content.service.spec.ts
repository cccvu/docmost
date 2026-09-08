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
