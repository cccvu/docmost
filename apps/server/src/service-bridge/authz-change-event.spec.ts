import { mapOutboxRow, OutboxRow } from './authz-change-event';

/**
 * The raw-outbox-row -> typed-event mapping owns ALL of Docmost's schema knowledge (Group D, #171). These
 * pin the wrinkles the platform must no longer know about: the soft-vs-hard-delete divergence, the page_access
 * restriction idiom, and the page_permissions cascade-delete skip covered by PageRestrictionChanged.
 *
 * NB: `payload` keys are CAMELCASE here because that is exactly what the fork's Kysely delivers — its
 * CamelCasePlugin recurses into the stored (snake_case) jsonb on read. The service always calls mapOutboxRow
 * with this post-plugin shape; the feed spec (which goes through the real spy compiler) uses snake_case rows
 * and lets the plugin camel-case them, proving both halves agree.
 */
const row = (over: Partial<OutboxRow> & Pick<OutboxRow, 'op' | 'tableName' | 'payload'>): OutboxRow => ({
  id: 42,
  ...over,
});

describe('mapOutboxRow', () => {
  it('spaces INSERT -> SpaceChanged (not deleted)', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'spaces', payload: { id: 's1', workspaceId: 'w1' } })),
    ).toEqual({ seq: 42, type: 'SpaceChanged', spaceId: 's1', workspaceId: 'w1', deleted: false });
  });

  it('spaces UPDATE with deletedAt -> SpaceChanged deleted (soft-delete)', () => {
    expect(
      mapOutboxRow(row({ op: 'UPDATE', tableName: 'spaces', payload: { id: 's1', workspaceId: 'w1', deletedAt: '2026-01-01T00:00:00Z' } })),
    ).toMatchObject({ type: 'SpaceChanged', deleted: true });
  });

  it('spaces hard DELETE -> SpaceChanged deleted', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'spaces', payload: { id: 's1', workspaceId: 'w1' } })),
    ).toMatchObject({ type: 'SpaceChanged', deleted: true });
  });

  it('space_members INSERT (user) -> SpaceMemberChanged', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'space_members', payload: { spaceId: 's1', userId: 'u1', groupId: null, role: 'writer' } })),
    ).toEqual({ seq: 42, type: 'SpaceMemberChanged', spaceId: 's1', userId: 'u1', groupId: null, role: 'writer', removed: false });
  });

  it('space_members UPDATE-to-deletedAt -> removed (soft-delete divergence)', () => {
    expect(
      mapOutboxRow(row({ op: 'UPDATE', tableName: 'space_members', payload: { spaceId: 's1', groupId: 'g1', userId: null, role: 'reader', deletedAt: 'x' } })),
    ).toMatchObject({ type: 'SpaceMemberChanged', groupId: 'g1', removed: true });
  });

  it('group_users hard DELETE -> GroupMemberChanged removed', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'group_users', payload: { groupId: 'g1', userId: 'u1' } })),
    ).toEqual({ seq: 42, type: 'GroupMemberChanged', groupId: 'g1', userId: 'u1', removed: true });
  });

  it('pages structural change -> PageStructureChanged', () => {
    expect(
      mapOutboxRow(row({ op: 'UPDATE', tableName: 'pages', payload: { id: 'p1', spaceId: 's1', parentPageId: 'p0' } })),
    ).toEqual({ seq: 42, type: 'PageStructureChanged', pageId: 'p1', spaceId: 's1', parentPageId: 'p0', deleted: false });
  });

  it('page_access INSERT -> PageRestrictionChanged restricted=true', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'page_access', payload: { id: 'pa1', pageId: 'p1' } })),
    ).toEqual({ seq: 42, type: 'PageRestrictionChanged', pageId: 'p1', restricted: true });
  });

  it('page_access DELETE -> PageRestrictionChanged restricted=false', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'page_access', payload: { id: 'pa1', pageId: 'p1' } })),
    ).toMatchObject({ type: 'PageRestrictionChanged', restricted: false });
  });

  it('page_permissions with trigger-enriched pageId -> PagePermissionChanged', () => {
    expect(
      mapOutboxRow(row({ op: 'INSERT', tableName: 'page_permissions', payload: { pageAccessId: 'pa1', pageId: 'p1', userId: 'u1', groupId: null, role: 'reader' } })),
    ).toEqual({ seq: 42, type: 'PagePermissionChanged', pageId: 'p1', userId: 'u1', groupId: null, role: 'reader', removed: false });
  });

  it('page_permissions cascade-delete with UNRESOLVED pageId -> skip (null; covered by PageRestrictionChanged)', () => {
    expect(
      mapOutboxRow(row({ op: 'DELETE', tableName: 'page_permissions', payload: { pageAccessId: 'pa1', pageId: null, userId: 'u1' } })),
    ).toBeNull();
  });

  it('unknown table -> null', () => {
    expect(mapOutboxRow(row({ op: 'INSERT', tableName: 'users', payload: { id: 'u1' } }))).toBeNull();
  });

  it('missing required id -> null (defensive)', () => {
    expect(mapOutboxRow(row({ op: 'INSERT', tableName: 'space_members', payload: { userId: 'u1', role: 'reader' } }))).toBeNull();
  });
});
