import { mapOutboxRow, OutboxRow } from './authz-change-event';

/**
 * The raw-outbox-row -> typed-event mapping owns ALL of Docmost's schema knowledge (Group D, #171). These
 * pin the wrinkles the platform must no longer know about: the soft-vs-hard-delete divergence, the page_access
 * restriction idiom, and the page_permissions cascade-delete skip covered by PageRestrictionChanged.
 *
 * NB: `payload` keys are SNAKE_CASE here because that is the shape mapOutboxRow receives. postgres.js returns a
 * jsonb column as a raw JSON STRING (it does not parse json/jsonb), so the feed JSON.parses it back to the
 * ORIGINAL stored snake_case object before mapping (see AuthzChangeFeedService.parsePayload); CamelCasePlugin
 * never touches a string, so no camel-casing occurs. The real-PG spec proves this end-to-end.
 */
const row = (over: Partial<OutboxRow> & Pick<OutboxRow, 'op' | 'tableName' | 'payload'>): OutboxRow => ({
  id: 42,
  ...over,
});

describe('mapOutboxRow', () => {
  it('spaces INSERT -> SpaceChanged (not deleted)', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'spaces', payload: { id: 's1', workspace_id: 'w1' } })),
    ).toEqual({ seq: 42, type: 'SpaceChanged', spaceId: 's1', workspaceId: 'w1', deleted: false });
  });

  it('spaces UPDATE with deleted_at -> SpaceChanged deleted (soft-delete)', () => {
    expect(
      mapOutboxRow(row({ op: 'UPDATE', tableName: 'spaces', payload: { id: 's1', workspace_id: 'w1', deleted_at: '2026-01-01T00:00:00Z' } })),
    ).toMatchObject({ type: 'SpaceChanged', deleted: true });
  });

  it('spaces hard DELETE -> SpaceChanged deleted', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'spaces', payload: { id: 's1', workspace_id: 'w1' } })),
    ).toMatchObject({ type: 'SpaceChanged', deleted: true });
  });

  it('space_members INSERT (user) -> SpaceMemberChanged', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'space_members', payload: { space_id: 's1', user_id: 'u1', group_id: null, role: 'writer' } })),
    ).toEqual({ seq: 42, type: 'SpaceMemberChanged', spaceId: 's1', userId: 'u1', groupId: null, role: 'writer', removed: false });
  });

  it('space_members UPDATE-to-deleted_at -> removed (soft-delete divergence)', () => {
    expect(
      mapOutboxRow(row({ op: 'UPDATE', tableName: 'space_members', payload: { space_id: 's1', group_id: 'g1', user_id: null, role: 'reader', deleted_at: 'x' } })),
    ).toMatchObject({ type: 'SpaceMemberChanged', groupId: 'g1', removed: true });
  });

  it('group_users hard DELETE -> GroupMemberChanged removed', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'group_users', payload: { group_id: 'g1', user_id: 'u1' } })),
    ).toEqual({ seq: 42, type: 'GroupMemberChanged', groupId: 'g1', userId: 'u1', removed: true });
  });

  it('pages structural change -> PageStructureChanged', () => {
    expect(
      mapOutboxRow(row({ op: 'UPDATE', tableName: 'pages', payload: { id: 'p1', space_id: 's1', parent_page_id: 'p0' } })),
    ).toEqual({ seq: 42, type: 'PageStructureChanged', pageId: 'p1', spaceId: 's1', parentPageId: 'p0', deleted: false });
  });

  it('page_access INSERT -> PageRestrictionChanged restricted=true', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'page_access', payload: { id: 'pa1', page_id: 'p1' } })),
    ).toEqual({ seq: 42, type: 'PageRestrictionChanged', pageId: 'p1', restricted: true });
  });

  it('page_access DELETE -> PageRestrictionChanged restricted=false', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'page_access', payload: { id: 'pa1', page_id: 'p1' } })),
    ).toMatchObject({ type: 'PageRestrictionChanged', restricted: false });
  });

  it('page_permissions with trigger-enriched page_id -> PagePermissionChanged', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'page_permissions', payload: { page_access_id: 'pa1', page_id: 'p1', user_id: 'u1', group_id: null, role: 'reader' } })),
    ).toEqual({ seq: 42, type: 'PagePermissionChanged', pageId: 'p1', userId: 'u1', groupId: null, role: 'reader', removed: false });
  });

  it('page_permissions normal DELETE with a resolved page_id -> PagePermissionChanged removed=true', () => {
    // The common single-permission revoke: page_access still exists so page_id resolves; the grant must be
    // reported REMOVED (not skipped, and removed must track the op — guards the removed:isDelete branch).
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'page_permissions', payload: { page_access_id: 'pa1', page_id: 'p1', user_id: 'u1', group_id: null, role: 'reader' } })),
    ).toEqual({ seq: 42, type: 'PagePermissionChanged', pageId: 'p1', userId: 'u1', groupId: null, role: 'reader', removed: true });
  });

  it('page_permissions cascade-delete with UNRESOLVED page_id -> skip (null; covered by PageRestrictionChanged)', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'page_permissions', payload: { page_access_id: 'pa1', page_id: null, user_id: 'u1' } })),
    ).toBeNull();
  });

  it('unknown table -> null', () => {
    expect(mapOutboxRow(row({ op: 'INSERT', tableName: 'users', payload: { id: 'u1' } }))).toBeNull();
  });

  it('missing required id -> null (defensive)', () => {
    expect(mapOutboxRow(row({ op: 'INSERT', tableName: 'space_members', payload: { user_id: 'u1', role: 'reader' } }))).toBeNull();
  });
});
