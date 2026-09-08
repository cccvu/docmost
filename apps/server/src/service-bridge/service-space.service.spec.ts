import { ConflictException, NotFoundException } from '@nestjs/common';
import { ServiceSpaceService } from './service-space.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

const workspaces = () => ({ resolveDefaultWorkspaceId: jest.fn(async () => 'ws1') }) as any;
const bridge = () =>
  ({
    provisionShadowUser: jest.fn(async ({ externalId }: { externalId: string }) => ({
      userId: `docmost-${externalId}`,
      workspaceId: 'ws1',
    })),
  }) as any;

const make = (respond: (q: SpyQuery) => unknown[]) => {
  const spy = spyKysely(respond);
  return { svc: new ServiceSpaceService(spy.db, workspaces(), bridge()), spy };
};

// Raw `sql` keeps its literal (unquoted, indented) text, so match with lowercased `includes`.
const q = (s: string) => s.toLowerCase();

describe('ServiceSpaceService.create — transactional atomicity', () => {
  it('rolls back the space row when the creator-member insert fails (no partial space)', async () => {
    // Force the SECOND insert (space_members) to fail INSIDE the transaction. The first insert (spaces) must
    // be rolled back — proving the two writes are one atomic unit (the outbox relies on both firing
    // together). We observe rollback (not commit) via the spy's transaction record.
    const { svc, spy } = make((query) => {
      const s = q(query.sql);
      if (s.includes('insert into space_members')) throw new Error('simulated member insert failure');
      if (s.includes('insert into spaces')) return [{ id: 'sp1', slug: 'sp', name: 'Sp' }];
      if (s.includes('select 1 from spaces')) return []; // dup pre-check: no dupe
      return [];
    });

    await expect(
      svc.create({ name: 'Sp', creatorExternalId: 'ext-1' } as any),
    ).rejects.toThrow('simulated member insert failure');

    expect(spy.tx).toEqual(['begin', 'rollback']); // rolled back, never committed
    expect(spy.tx).not.toContain('commit');
  });

  it('commits when both inserts succeed (happy path is one transaction)', async () => {
    const { svc, spy } = make((query) => {
      const s = q(query.sql);
      if (s.includes('insert into spaces')) return [{ id: 'sp1', slug: 'sp', name: 'Sp' }];
      if (s.includes('select 1 from spaces')) return [];
      return [];
    });

    await expect(svc.create({ name: 'Sp', creatorExternalId: 'ext-1' } as any)).resolves.toEqual({
      id: 'sp1',
      slug: 'sp',
      name: 'Sp',
    });
    expect(spy.tx).toEqual(['begin', 'commit']);
    // Both writes ran (spaces then space_members).
    expect(spy.calls.some((c) => q(c.sql).includes('insert into spaces'))).toBe(true);
    expect(spy.calls.some((c) => q(c.sql).includes('insert into space_members'))).toBe(true);
  });

  it('409s (and opens NO transaction) when the slug is already taken', async () => {
    const { svc, spy } = make((query) =>
      q(query.sql).includes('select 1 from spaces') ? [{ exists: 1 }] : [],
    );
    await expect(
      svc.create({ name: 'Sp', slug: 'taken', creatorExternalId: 'ext-1' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(spy.tx).toEqual([]); // never entered a transaction
  });
});

describe('ServiceSpaceService.archive — reversible soft-delete', () => {
  it('sets deleted_at (soft delete), scoped to an ACTIVE space, and 404s a missing/archived one', async () => {
    const ok = make((query) => (q(query.sql).includes('update spaces set') ? [{ id: 'sp1' }] : []));
    await expect(ok.svc.archive('sp1')).resolves.toBeUndefined();
    const upd = ok.spy.calls.find((c) => q(c.sql).includes('update spaces set'))!;
    expect(q(upd.sql)).toContain('deleted_at = now()');
    expect(q(upd.sql)).toContain('deleted_at is null'); // only archives an active space

    const missing = make(() => []);
    await expect(missing.svc.archive('sp1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ServiceSpaceService.listMembers — opt-in keyset paging (backward-compatible)', () => {
  // listMembers runs loadSpace (a `from spaces` query) first, then the `from space_members` query, so the
  // members query is always the SECOND spy call (spy.calls[1]).
  const spaceRow = () => ({
    id: 'sp1', name: 'S', slug: 's', description: null, visibility: 'private',
    createdAt: new Date('2026-01-01T00:00:00.000Z'), deletedAt: null, memberCount: '0',
  });
  const respond = (query: SpyQuery) => (q(query.sql).includes('from spaces') ? [spaceRow()] : []);

  it('unpaged (no limit) keeps the legacy query: created_at asc, no keyset, no limit', async () => {
    const { svc, spy } = make(respond);
    await svc.listMembers('sp1');
    const sql = q(spy.calls[1].sql);
    expect(sql).toContain('order by created_at asc');
    expect(sql).not.toContain('date_trunc');
    expect(sql).not.toContain('limit');
  });

  it('paged uses the ms-truncated id-tiebroken ascending keyset + limit+1', async () => {
    const { svc, spy } = make(respond);
    await svc.listMembers('sp1', { limit: 25, before: { createdAt: '2026-01-01T00:00:00.000Z', id: 'm-9' } });
    const call = spy.calls[1];
    const sql = q(call.sql);
    expect(sql).toContain("date_trunc('milliseconds', created_at) asc");
    expect(sql).toContain('id::text asc');
    expect(sql).toContain('> (');
    expect(call.parameters).toContainEqual(26); // limit + 1
  });
});
