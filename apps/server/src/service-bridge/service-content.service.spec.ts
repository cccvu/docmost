import { NotFoundException } from '@nestjs/common';
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
