import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ServiceSpaceService } from './service-space.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

const workspaces = () => ({ resolveDefaultWorkspaceId: jest.fn(async () => 'ws1') }) as any;
const bridge = () =>
  ({
    provisionShadowUser: jest.fn(async ({ externalId }: { externalId: string }) => ({
      userId: `docmost-${externalId}`,
      workspaceId: 'ws1',
    })),
    // The rule-M actor lookup (never provisions); `ext-ghost` models a never-provisioned identity.
    findShadowUserId: jest.fn(async (externalId: string) =>
      externalId === 'ext-ghost' ? null : `docmost-${externalId}`,
    ),
  }) as any;

const make = (respond: (q: SpyQuery) => unknown[]) => {
  const spy = spyKysely(respond);
  return { svc: new ServiceSpaceService(spy.db, workspaces(), bridge()), spy };
};

// Raw `sql` keeps its literal (unquoted, indented) text, so match with lowercased `includes`.
const q = (s: string) => s.toLowerCase();

/** #616: a rename / archive / role change now answers the resource's new version. */
const VERSIONED = { version: expect.stringMatching(/^[0-9a-f]{64}$/) };

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

/**
 * #616 — the KEYED create: the ledger reservation sits in the space insert's own bounded transaction; a replay re-runs
 * nothing; a mismatch writes nothing; the key is bound to the service credential + the creator; no friendly slug
 * pre-check (the retry's own space holds the slug); unkeyed stays byte-identical (no `replayed`).
 */
describe('ServiceSpaceService.create — keyed (#616)', () => {
  const FP = 'f'.repeat(64);
  const keyed = { name: 'Sp', creatorExternalId: 'ext-1', idempotencyKey: 'k-1', idempotencyNamespace: 'user:ext-1', fingerprint: FP };
  const slot = { namespaceDigest: 'n'.repeat(64), op: 'space.create', keyDigest: 'd'.repeat(64) };

  const makeKeyed = (reservation: unknown, respond: (q: SpyQuery) => unknown[] = () => [], reserveThrows?: unknown) => {
    const spy = spyKysely(respond);
    const order: string[] = [];
    const b = bridge();
    b.provisionShadowUser.mockImplementation(async ({ externalId }: { externalId: string }) => {
      order.push(`provision:${spy.tx.join('>')}`);
      return { userId: `docmost-${externalId}`, workspaceId: 'ws1' };
    });
    const ledger = {
      reserve: jest.fn(async (_trx: unknown, _claim: unknown) => {
        order.push(`reserve:${spy.tx.join('>')}`);
        if (reserveThrows) throw reserveThrows;
        return reservation;
      }),
      complete: jest.fn(async (_trx: unknown, s: unknown, id: string) => {
        order.push(`complete:${id}`);
        expect(s).toBe(slot);
      }),
    };
    const svc = new ServiceSpaceService(spy.db, workspaces(), b, ledger as any);
    return { svc, spy, ledger, order, b };
  };
  const inserts = (spy: { calls: SpyQuery[] }) =>
    spy.calls.map((c) => q(c.sql)).filter((c) => c.includes('insert into')).map((c) => c.match(/insert into (\w+)/)![1]);

  it('fresh: provision → BEGIN → SET LOCAL bounds → reserve → the SAME two inserts → complete → COMMIT; replayed:false', async () => {
    const t = makeKeyed({ outcome: 'fresh', slot }, (query) =>
      q(query.sql).includes('insert into spaces') ? [{ id: 'sp1', slug: 'sp', name: 'Sp' }] : [],
    );
    await expect(t.svc.create(keyed as any, 'shared')).resolves.toEqual({ id: 'sp1', slug: 'sp', name: 'Sp', replayed: false });
    expect(t.order).toEqual(['provision:', 'reserve:begin', 'complete:sp1']);
    expect(t.spy.calls.slice(0, 2).map((c) => c.sql)).toEqual([
      "SET LOCAL lock_timeout = '2s'",
      "SET LOCAL statement_timeout = '15s'",
    ]);
    expect(inserts(t.spy)).toEqual(['spaces', 'space_members']);
    expect(t.spy.calls.some((c) => q(c.sql).includes('select 1 from spaces'))).toBe(false); // no friendly pre-check
    expect(t.spy.tx).toEqual(['begin', 'commit']);
    expect(t.ledger.reserve.mock.calls[0][1]).toEqual({
      workspaceId: 'ws1',
      principal: 'service:shared/user:docmost-ext-1', // the credential + the acting human, as the fork resolved it
      namespace: 'user:ext-1',
      op: 'space.create',
      key: 'k-1',
      fingerprint: FP,
    });
  });

  it('replay: reads the space the key created; NO insert, NO complete; replayed:true', async () => {
    const t = makeKeyed({ outcome: 'replay', resourceId: 'sp0' }, (query) =>
      q(query.sql).includes('select id, slug, name from spaces') ? [{ id: 'sp0', slug: 'sp', name: 'Sp' }] : [],
    );
    await expect(t.svc.create(keyed as any, 'shared')).resolves.toEqual({ id: 'sp0', slug: 'sp', name: 'Sp', replayed: true });
    expect(inserts(t.spy)).toEqual([]);
    expect(t.ledger.complete).not.toHaveBeenCalled();
    const read = t.spy.calls.find((c) => q(c.sql).includes('select id, slug, name from spaces'))!;
    expect(read.parameters).toEqual(['sp0', 'ws1']); // workspace-scoped
  });

  it('replay of a space that is gone → 404 idempotency_resource_gone', async () => {
    const t = makeKeyed({ outcome: 'replay', resourceId: 'sp0' });
    const err = await t.svc.create(keyed as any, 'shared').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse()).toMatchObject({ code: 'idempotency_resource_gone' });
  });

  it('mismatch → 409 idempotency_key_reused, rolled back, nothing inserted', async () => {
    const t = makeKeyed({ outcome: 'mismatch' });
    const err = await t.svc.create(keyed as any, 'shared').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(inserts(t.spy)).toEqual([]);
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
  });

  it('a slug held by another space (23505) → the same 409 as unkeyed, and the reservation rolls back with it', async () => {
    const t = makeKeyed({ outcome: 'fresh', slot }, (query) => {
      if (q(query.sql).includes('insert into spaces')) throw Object.assign(new Error('dup'), { code: '23505' });
      return [];
    });
    await expect(t.svc.create(keyed as any, 'shared')).rejects.toThrow('a space with the slug "sp" already exists');
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
    expect(t.ledger.complete).not.toHaveBeenCalled();
  });

  it.each(['55P03', '40P01', '57014'])('a busy engine (%s) → 503 engine_busy', async (code) => {
    const t = makeKeyed(undefined, () => [], Object.assign(new Error('busy'), { code }));
    const err = await t.svc.create(keyed as any, 'shared').catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({ code: 'engine_busy' });
  });

  it('fails closed without an authenticated credential or an injected ledger: nothing provisioned, no transaction', async () => {
    const noCred = makeKeyed({ outcome: 'fresh', slot });
    await expect(noCred.svc.create(keyed as any)).rejects.toThrow(/keyed create unavailable/);
    expect(noCred.b.provisionShadowUser).not.toHaveBeenCalled();
    expect(noCred.spy.tx).toEqual([]);
    const spy = spyKysely(() => []);
    const noLedger = new ServiceSpaceService(spy.db, workspaces(), bridge());
    await expect(noLedger.create(keyed as any, 'shared')).rejects.toThrow(/keyed create unavailable/);
    expect(spy.tx).toEqual([]);
  });

  it('unkeyed: the pre-#616 statements, never the ledger, and no `replayed` in the body', async () => {
    const t = makeKeyed({ outcome: 'fresh', slot }, (query) =>
      q(query.sql).includes('insert into spaces') ? [{ id: 'sp1', slug: 'sp', name: 'Sp' }] : [],
    );
    const res = await t.svc.create({ name: 'Sp', creatorExternalId: 'ext-1' } as any, 'shared');
    expect(Object.keys(res).sort()).toEqual(['id', 'name', 'slug']);
    expect(t.ledger.reserve).not.toHaveBeenCalled();
    expect(t.spy.calls.map((c) => q(c.sql).trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'select 1 from',
      'insert into spaces',
      'insert into space_members',
    ]);
  });
});

describe('ServiceSpaceService.archive — reversible soft-delete', () => {
  it('sets deleted_at (soft delete), scoped to an ACTIVE space, and 404s a missing/archived one', async () => {
    const ok = make((query) => (q(query.sql).includes('update spaces set') ? [{ id: 'sp1' }] : []));
    await expect(ok.svc.archive('sp1')).resolves.toEqual(VERSIONED);
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

describe('ServiceSpaceService member mutations — last-admin invariant (#486)', () => {
  // A scripted world for the spy: the space lock row, the target member row, and how many OTHER live admins the
  // count query sees. `loadSpace` (addMember's fast pre-check) reads `from spaces s`.
  type World = {
    space?: 'live' | 'archived' | 'missing';
    member?: { id?: string; role: string; deletedAt?: Date | null; userId?: string | null; groupId?: string | null } | null;
    otherAdmins?: number;
    inGroup?: boolean; // whether the group_users probe finds the actor in the row's group
  };
  const respondTo = (w: World) => (query: SpyQuery) => {
    const s = q(query.sql);
    const space = w.space ?? 'live';
    if (s.includes('for no key update')) {
      return space === 'missing' ? [] : [{ id: 'sp1', deletedAt: space === 'archived' ? new Date() : null }];
    }
    if (s.includes('from spaces s')) {
      return space === 'missing'
        ? []
        : [{ id: 'sp1', name: 'S', slug: 's', description: null, visibility: 'private', createdAt: new Date(),
             deletedAt: space === 'archived' ? new Date() : null, memberCount: '1' }];
    }
    if (s.includes('from space_members') && s.includes('for update')) {
      return w.member ? [{ id: 'm1', deletedAt: null, userId: 'docmost-ext-other', groupId: null, ...w.member }] : [];
    }
    if (s.includes('count(*)::int as n')) return [{ n: w.otherAdmins ?? 0 }];
    if (s.includes('from group_users')) return w.inGroup ? [{ one: 1 }] : [];
    if (s.includes('insert into space_members')) return [{ id: 'm1' }];
    return [];
  };
  const idx = (spy: { calls: SpyQuery[] }, needle: string) => spy.calls.findIndex((c) => q(c.sql).includes(needle));
  const ran = (spy: { calls: SpyQuery[] }, needle: string) => idx(spy, needle) !== -1;

  describe('changeMemberRole', () => {
    it('locks the space row FOR NO KEY UPDATE first, then loads the member by id AND space_id', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'writer' } }));
      await svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-actor');
      expect(spy.tx).toEqual(['begin', 'commit']);
      const lock = idx(spy, 'for no key update');
      expect(lock).toBe(0); // the first statement of the transaction (the workspace resolver is a stub)
      expect(idx(spy, 'from space_members')).toBeGreaterThan(lock);
      const load = spy.calls[idx(spy, 'from space_members')];
      expect(q(load.sql)).toContain('space_id =');
      expect(load.parameters).toEqual(expect.arrayContaining(['m1', 'sp1']));
      expect(ran(spy, 'count(*)::int')).toBe(false); // demoting a non-admin never counts admins
    });

    it('409s demoting the sole live admin (rolled back, no UPDATE)', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin' }, otherAdmins: 0 }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'writer', 'ext-actor')).rejects.toBeInstanceOf(ConflictException);
      expect(spy.tx).toEqual(['begin', 'rollback']);
      expect(ran(spy, 'update space_members')).toBe(false);
      // The count excludes the target and filters soft-deleted rows (user AND group rows both count).
      const count = spy.calls[idx(spy, 'count(*)::int')];
      expect(q(count.sql)).toContain("role = 'admin'");
      expect(q(count.sql)).toContain('deleted_at is null');
      expect(q(count.sql)).not.toContain('user_id');
      expect(count.parameters).toContain('m1');
    });

    it('commits the demotion when another live admin remains', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin' }, otherAdmins: 1 }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-actor')).resolves.toEqual(VERSIONED);
      expect(spy.tx).toEqual(['begin', 'commit']);
      expect(ran(spy, 'update space_members')).toBe(true);
    });

    it('does not count admins for an admin→admin write (not a demotion)', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin' }, otherAdmins: 0 }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'admin', 'ext-actor')).resolves.toEqual(VERSIONED);
      expect(ran(spy, 'count(*)::int')).toBe(false);
    });

    it('400s on an archived space and 404s a missing space or member (all before any write)', async () => {
      const archived = make(respondTo({ space: 'archived', member: { role: 'writer' } }));
      await expect(archived.svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-actor')).rejects.toBeInstanceOf(BadRequestException);
      const noSpace = make(respondTo({ space: 'missing' }));
      await expect(noSpace.svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-actor')).rejects.toBeInstanceOf(NotFoundException);
      const noMember = make(respondTo({ member: null }));
      await expect(noMember.svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-actor')).rejects.toBeInstanceOf(NotFoundException);
      for (const { spy } of [archived, noSpace, noMember]) {
        expect(spy.tx).toEqual(['begin', 'rollback']);
        expect(ran(spy, 'update space_members')).toBe(false);
      }
    });
  });

  describe('removeMember', () => {
    it('409s removing the sole live admin (rolled back, no DELETE)', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin' }, otherAdmins: 0 }));
      await expect(svc.removeMember('sp1', 'm1')).rejects.toBeInstanceOf(ConflictException);
      expect(spy.tx).toEqual(['begin', 'rollback']);
      expect(ran(spy, 'delete from space_members')).toBe(false);
      expect(q(spy.calls[0].sql)).toContain('for no key update');
    });

    it('stays allowed on an ARCHIVED space, but is still guarded there', async () => {
      const guarded = make(respondTo({ space: 'archived', member: { role: 'admin' }, otherAdmins: 0 }));
      await expect(guarded.svc.removeMember('sp1', 'm1')).rejects.toBeInstanceOf(ConflictException);
      const ok = make(respondTo({ space: 'archived', member: { role: 'writer' } }));
      await expect(ok.svc.removeMember('sp1', 'm1')).resolves.toBeUndefined();
      expect(ok.spy.tx).toEqual(['begin', 'commit']);
      expect(ran(ok.spy, 'delete from space_members')).toBe(true);
    });

    it('a soft-deleted admin row is not a live admin: removing it needs no other admin', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin', deletedAt: new Date() }, otherAdmins: 0 }));
      await expect(svc.removeMember('sp1', 'm1')).resolves.toBeUndefined();
      expect(ran(spy, 'count(*)::int')).toBe(false);
      expect(ran(spy, 'delete from space_members')).toBe(true);
    });

    it('404s a member that is not in this space', async () => {
      const { svc, spy } = make(respondTo({ member: null }));
      await expect(svc.removeMember('sp1', 'm1')).rejects.toBeInstanceOf(NotFoundException);
      expect(ran(spy, 'delete from space_members')).toBe(false);
    });
  });

  describe('addMember (the upsert can re-role an existing live row)', () => {
    const dto = (role: 'admin' | 'writer' | 'reader') =>
      ({ externalId: 'ext-m', role, addedByExternalId: 'ext-a' }) as any;

    it('409s an upsert that would demote the sole live admin (no INSERT reaches the table)', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin' }, otherAdmins: 0 }));
      await expect(svc.addMember('sp1', dto('writer'))).rejects.toBeInstanceOf(ConflictException);
      expect(spy.tx).toEqual(['begin', 'rollback']);
      expect(ran(spy, 'insert into space_members')).toBe(false);
    });

    it('locks inside the transaction AFTER the pre-check and provisioning, then upserts on commit', async () => {
      const { svc, spy } = make(respondTo({ member: null }));
      await expect(svc.addMember('sp1', dto('writer'))).resolves.toEqual({ memberId: 'm1', userId: 'docmost-ext-m', ...VERSIONED });
      expect(spy.tx).toEqual(['begin', 'commit']);
      expect(idx(spy, 'from spaces s')).toBeLessThan(idx(spy, 'for no key update')); // fast pre-check first
      expect(idx(spy, 'for no key update')).toBeLessThan(idx(spy, 'insert into space_members'));
      expect(ran(spy, 'count(*)::int')).toBe(false);
    });

    it('400s an archived space before provisioning anyone (no transaction opened)', async () => {
      const { svc, spy } = make(respondTo({ space: 'archived' }));
      await expect(svc.addMember('sp1', dto('reader'))).rejects.toBeInstanceOf(BadRequestException);
      expect(spy.tx).toEqual([]);
    });
  });
});

describe('ServiceSpaceService member mutations — rule M, no self-raising writes (#486)', () => {
  // Same scripted world as the last-admin block, trimmed to what rule M reads.
  const respondTo = (w: {
    member?: { role: string; userId?: string | null; groupId?: string | null } | null;
    otherAdmins?: number;
    inGroup?: boolean;
  }) => (query: SpyQuery) => {
    const s = q(query.sql);
    if (s.includes('for no key update')) return [{ id: 'sp1', deletedAt: null }];
    if (s.includes('from spaces s')) {
      return [{ id: 'sp1', name: 'S', slug: 's', description: null, visibility: 'private', createdAt: new Date(),
                deletedAt: null, memberCount: '1' }];
    }
    if (s.includes('from space_members') && s.includes('for update')) {
      return w.member ? [{ id: 'm1', deletedAt: null, userId: null, groupId: null, ...w.member }] : [];
    }
    if (s.includes('count(*)::int as n')) return [{ n: w.otherAdmins ?? 0 }];
    if (s.includes('from group_users')) return w.inGroup ? [{ one: 1 }] : [];
    if (s.includes('insert into space_members')) return [{ id: 'm1' }];
    return [];
  };
  const ran = (spy: { calls: SpyQuery[] }, needle: string) => spy.calls.some((c) => q(c.sql).includes(needle));
  /** Assert a rejection is the 403 whose body carries `code: 'self_grant'`. */
  const expectSelfGrant = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'self_grant' });
  };
  const add = (externalId: string, role: 'admin' | 'writer' | 'reader', addedByExternalId = 'ext-me') =>
    ({ externalId, role, addedByExternalId }) as any;
  const ME = 'docmost-ext-me'; // what both bridge mocks resolve `ext-me` to

  describe('addMember (member vs addedBy shadow ids)', () => {
    it.each(['reader', 'writer', 'admin'] as const)('refuses adding yourself as %s (rolled back, no INSERT)', async (role) => {
      const { svc, spy } = make(respondTo({ member: null }));
      await expectSelfGrant(svc.addMember('sp1', add('ext-me', role)));
      expect(spy.tx).toEqual(['begin', 'rollback']);
      expect(ran(spy, 'insert into space_members')).toBe(false);
    });

    it('refuses raising your own live row, and a soft-deleted own row ranks as none', async () => {
      const raise = make(respondTo({ member: { role: 'reader', userId: ME } }));
      await expectSelfGrant(raise.svc.addMember('sp1', add('ext-me', 'writer')));
      // The live-row probe filters deleted_at, so a soft-deleted own row reads as absent (rank 0) → refused.
      const revive = make(respondTo({ member: null }));
      await expectSelfGrant(revive.svc.addMember('sp1', add('ext-me', 'reader')));
    });

    it('allows narrowing your own row (still subject to the last-admin guard) and a same-role no-op', async () => {
      const demote = make(respondTo({ member: { role: 'admin', userId: ME }, otherAdmins: 1 }));
      await expect(demote.svc.addMember('sp1', add('ext-me', 'reader'))).resolves.toMatchObject({ memberId: 'm1' });
      const last = make(respondTo({ member: { role: 'admin', userId: ME }, otherAdmins: 0 }));
      await expect(last.svc.addMember('sp1', add('ext-me', 'reader'))).rejects.toBeInstanceOf(ConflictException);
      const same = make(respondTo({ member: { role: 'writer', userId: ME } }));
      await expect(same.svc.addMember('sp1', add('ext-me', 'writer'))).resolves.toMatchObject({ memberId: 'm1' });
    });

    it('allows adding SOMEONE ELSE at any role', async () => {
      const { svc, spy } = make(respondTo({ member: null }));
      await expect(svc.addMember('sp1', add('ext-other', 'admin'))).resolves.toMatchObject({ memberId: 'm1' });
      expect(spy.tx).toEqual(['begin', 'commit']);
    });
  });

  describe('changeMemberRole (actor from the required actorExternalId)', () => {
    it('refuses raising your own row — after the lock and the row load, before any UPDATE', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'reader', userId: ME } }));
      await expectSelfGrant(svc.changeMemberRole('sp1', 'm1', 'admin', 'ext-me'));
      expect(spy.tx).toEqual(['begin', 'rollback']);
      expect(q(spy.calls[0].sql)).toContain('for no key update');
      expect(ran(spy, 'update space_members')).toBe(false);
    });

    it('allows demoting your own row', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin', userId: ME }, otherAdmins: 1 }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'writer', 'ext-me')).resolves.toEqual(VERSIONED);
      expect(ran(spy, 'update space_members')).toBe(true);
    });

    it('refuses raising a GROUP row the actor belongs to; allows it when the actor is not in the group', async () => {
      const mine = make(respondTo({ member: { role: 'reader', groupId: 'g1' }, inGroup: true }));
      await expectSelfGrant(mine.svc.changeMemberRole('sp1', 'm1', 'writer', 'ext-me'));
      const probe = mine.spy.calls.find((c) => q(c.sql).includes('from group_users'))!;
      expect(probe.parameters).toEqual(['g1', ME]);

      const notMine = make(respondTo({ member: { role: 'reader', groupId: 'g1' }, inGroup: false }));
      await expect(notMine.svc.changeMemberRole('sp1', 'm1', 'writer', 'ext-me')).resolves.toEqual(VERSIONED);
    });

    it('allows demoting a group row the actor belongs to (narrowing never widens anyone)', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'admin', groupId: 'g1' }, inGroup: true, otherAdmins: 1 }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-me')).resolves.toEqual(VERSIONED);
      expect(ran(spy, 'from group_users')).toBe(false); // not a raise → coverage is never consulted
    });

    it("allows raising someone else's user row without consulting group_users", async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'reader', userId: 'docmost-ext-other' } }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'admin', 'ext-me')).resolves.toEqual(VERSIONED);
      expect(ran(spy, 'from group_users')).toBe(false);
    });

    it('an actor with no shadow user is covered by nothing (a null id never matches a null user_id)', async () => {
      const { svc, spy } = make(respondTo({ member: { role: 'reader', userId: null, groupId: 'g1' }, inGroup: true }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'admin', 'ext-ghost')).resolves.toEqual(VERSIONED);
      expect(ran(spy, 'from group_users')).toBe(false);
    });

    it('an unrecognized stored role (even a prototype key) ranks as none, so any raise of it is refused', async () => {
      const { svc } = make(respondTo({ member: { role: 'toString', userId: ME } }));
      await expectSelfGrant(svc.changeMemberRole('sp1', 'm1', 'reader', 'ext-me'));
    });

    it('a missing row is a 404, never judged as "not self"', async () => {
      const { svc } = make(respondTo({ member: null }));
      await expect(svc.changeMemberRole('sp1', 'm1', 'admin', 'ext-me')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('ServiceSpaceService.unarchive', () => {
  it('404s a space that is missing or not archived', async () => {
    const { svc } = make(() => []);
    await expect(svc.unarchive('sp1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a unique violation (the personal-space index) to 409, and rethrows any other error', async () => {
    const unique = make(() => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    await expect(unique.svc.unarchive('sp1')).rejects.toBeInstanceOf(ConflictException);

    const other = make(() => {
      throw Object.assign(new Error('boom'), { code: '57014' });
    });
    await expect(other.svc.unarchive('sp1')).rejects.toThrow('boom');
  });
});
