import { AuthzSnapshotService } from './authz-snapshot.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

/**
 * The reconciler snapshot (Group D, #171): the full desired set as typed events, keyset-paginated on each
 * row's IMMUTABLE id (the race-safety guarantee), one concern-phase per page.
 */
describe('AuthzSnapshotService', () => {
  it('emits SpaceChanged for the spaces phase and advances to the next phase when a page is short', async () => {
    const spy = spyKysely((q: SpyQuery) => {
      if (q.sql.includes('from spaces')) return [{ id: 's1', workspace_id: 'w1' }];
      return [];
    });
    const svc = new AuthzSnapshotService(spy.db);
    const res = await svc.getSnapshot(undefined, 500);
    expect(res.events).toEqual([{ seq: 0, type: 'SpaceChanged', spaceId: 's1', workspaceId: 'w1', deleted: false }]);
    // spaces returned < limit -> advance to phase index 1 (space_members) at the zero uuid.
    expect(res.nextCursor).toBe('1.00000000-0000-0000-0000-000000000000');
    // keyset uses the immutable id, filters non-deleted.
    expect(spy.calls[0].sql).toMatch(/deleted_at is null/);
    expect(spy.calls[0].sql).toMatch(/id >/);
  });

  it('keeps paging the same phase when a full page is returned', async () => {
    const spy = spyKysely((q: SpyQuery) => {
      if (q.sql.includes('from spaces')) return [{ id: 's9', workspace_id: 'w1' }];
      return [];
    });
    const svc = new AuthzSnapshotService(spy.db);
    const res = await svc.getSnapshot(undefined, 1); // limit 1, one row -> full page -> stay in phase
    expect(res.nextCursor).toBe('0.s9');
  });

  it('page_permissions is the last phase; a short page ends the snapshot (nextCursor null)', async () => {
    const spy = spyKysely((q: SpyQuery) => {
      if (q.sql.includes('from page_permissions')) {
        return [{ id: 'pp1', page_id: 'p1', user_id: 'u1', group_id: null, role: 'writer' }];
      }
      return [];
    });
    const svc = new AuthzSnapshotService(spy.db);
    const res = await svc.getSnapshot('5.00000000-0000-0000-0000-000000000000', 500); // phase 5 = page_permissions
    expect(res.events).toEqual([
      { seq: 0, type: 'PagePermissionChanged', pageId: 'p1', userId: 'u1', groupId: null, role: 'writer', removed: false },
    ]);
    expect(res.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    const svc = new AuthzSnapshotService(spyKysely(() => []).db);
    await expect(svc.getSnapshot('nope', 500)).rejects.toThrow();
    await expect(svc.getSnapshot('9.00000000-0000-0000-0000-000000000000', 500)).rejects.toThrow(); // phase out of range
    // 36 chars but not a valid UUID -> 400 at validation, not a 500 at the uuid cast.
    await expect(svc.getSnapshot('0.------------------------------------', 500)).rejects.toThrow();
  });
});
