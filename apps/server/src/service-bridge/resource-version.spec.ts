import { ConflictException, HttpException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// Stage 1's conditional page controller pulls PageService → the collab gateway, whose lib0/hocuspocus ESM graph jest
// cannot load; only its exported SQLSTATE set is read here (the same stub its own pg spec uses).
jest.mock('../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { ENGINE_BUSY_SQLSTATES } from '../authz/page-write/conditional-page-ops.controller';
import { PublicSpaceSummary } from './service-content.service';
import {
  aclEntry,
  aclVersion,
  asEngineBusy,
  assertExpectedVersion,
  byCodePoint,
  IsExpectedVersion,
  MAX_EXPECTED_VERSION_LENGTH,
  memberRowVersion,
  memberVersion,
  refusal,
  refusalCodeOf,
  SPACE_VERSION_KEYS,
  spaceVersion,
  SpaceVersionMaterial,
  VERSIONED_WRITE_BUSY_SQLSTATES,
  versionMatches,
} from './resource-version';

/**
 * #616 Stage 2 — the fork-issued version tokens. Pure functions: the material each version covers (and the pin the
 * platform relies on — its space DTO keys ⊆ SPACE_VERSION_KEYS), order- and case-insensitivity where the resource
 * is, and the compare's `*` semantics. Golden vectors pin the digest itself: a change here re-issues every version
 * a client holds (one 412 per client, then a re-read) — it should be deliberate.
 */
const SPACE: SpaceVersionMaterial = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Space',
  slug: 'space',
  description: null,
  visibility: 'open',
  createdAt: '2026-09-26T10:00:00.123Z',
  updatedAt: '2026-09-26T11:00:00.456Z',
  archived: false,
};

describe('spaceVersion', () => {
  it('pins the key list (the platform pins its SpaceDto keys ⊆ this list)', () => {
    expect([...SPACE_VERSION_KEYS]).toEqual([
      'id',
      'name',
      'slug',
      'description',
      'visibility',
      'createdAt',
      'updatedAt',
      'archived',
    ]);
  });

  it('covers EVERY field of the public space detail the bridge serves, plus archived', () => {
    // A compile-time closed map of PublicSpaceSummary: a field added there fails to compile here until it is placed.
    const summary: Record<keyof PublicSpaceSummary, true> = {
      id: true,
      name: true,
      slug: true,
      description: true,
      visibility: true,
      createdAt: true,
      updatedAt: true,
    };
    for (const k of [...Object.keys(summary), 'archived']) {
      expect(SPACE_VERSION_KEYS as readonly string[]).toContain(k);
    }
  });

  it.each(SPACE_VERSION_KEYS.map((k) => [k]))('changes when %s changes', (key) => {
    const changed: Record<string, unknown> = { ...SPACE };
    changed[key] =
      key === 'archived'
        ? true
        : key === 'createdAt' || key === 'updatedAt'
          ? '2026-09-26T12:00:00.000Z'
          : key === 'id'
            ? '22222222-2222-4222-8222-222222222222'
            : `${String(SPACE[key as keyof SpaceVersionMaterial])}-x`;
    expect(spaceVersion(changed as never)).not.toBe(spaceVersion(SPACE));
  });

  it('a driver Date and its ISO string digest alike (µs in the database, ms on the wire); ids are case-insensitive', () => {
    const asDates = { ...SPACE, createdAt: new Date(SPACE.createdAt as string), updatedAt: new Date(SPACE.updatedAt as string) };
    expect(spaceVersion(asDates)).toBe(spaceVersion(SPACE));
    expect(spaceVersion({ ...SPACE, id: SPACE.id.toUpperCase() })).toBe(spaceVersion(SPACE));
  });

  it('ignores anything outside the material (the member count, the version itself)', () => {
    expect(spaceVersion({ ...SPACE, memberCount: 7, version: 'x' } as never)).toBe(spaceVersion(SPACE));
  });

});

describe('golden vectors (a change re-issues every version clients hold — make it deliberately)', () => {
  it('space / member / ACL', () => {
    expect(spaceVersion(SPACE)).toBe('fa89a5238f74a07179678dd41085679dc06742e7e29299bbfe67ff2149b91380');
    expect(
      memberVersion({ spaceId: SPACE.id, memberType: 'user', memberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'writer', live: true }),
    ).toBe('30ea2939628a5481ab7622a79320e186ea40c9e631b96a4c49b1424b5d2825a0');
    const PAGE = '33333333-3333-4333-8333-333333333333';
    expect(
      aclVersion({
        pageId: PAGE,
        restricted: true,
        entries: ['u:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:reader', 'g:cccccccc-cccc-4ccc-8ccc-cccccccccccc:writer'],
      }),
    ).toBe('58d108ed8fa93a9d3d3d672829e9121f2db6f416e0251292534df8217a965b4e');
    expect(aclVersion({ pageId: PAGE, restricted: false, entries: [] })).toBe(
      '2449ebb1523c5558a56f542787bb1d55c67c0c6a6b7f393d83b196ce7eb2f07f',
    );
  });
});

describe('memberVersion', () => {
  const M = { spaceId: SPACE.id, memberType: 'user' as const, memberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'writer', live: true };

  it.each([
    ['spaceId', { spaceId: '22222222-2222-4222-8222-222222222222' }],
    ['memberType', { memberType: 'group' as const }],
    ['memberId', { memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['role', { role: 'admin' }],
    ['live', { live: false }],
  ])('changes when %s changes', (_k, patch) => {
    expect(memberVersion({ ...M, ...patch })).not.toBe(memberVersion(M));
  });

  it('a row maps to user:<id> or group:<id>, live = not soft-deleted', () => {
    expect(memberRowVersion(SPACE.id, { userId: M.memberId, groupId: null, role: 'writer', deletedAt: null })).toBe(memberVersion(M));
    expect(memberRowVersion(SPACE.id, { userId: null, groupId: M.memberId, role: 'writer', deletedAt: null })).toBe(
      memberVersion({ ...M, memberType: 'group' }),
    );
    expect(memberRowVersion(SPACE.id, { userId: M.memberId, groupId: null, role: 'writer', deletedAt: new Date() })).toBe(
      memberVersion({ ...M, live: false }),
    );
  });

  it('is never equal to a space or ACL version over similar material (format-tagged per kind)', () => {
    expect(memberVersion(M)).not.toBe(aclVersion({ pageId: SPACE.id, restricted: true, entries: [] }));
  });
});

describe('aclVersion', () => {
  const PAGE = '33333333-3333-4333-8333-333333333333';
  const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const G = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const entries = [aclEntry({ userId: U, groupId: null, role: 'reader' }), aclEntry({ userId: null, groupId: G, role: 'writer' })];

  it('entries are u:<id>:<role> / g:<id>:<role>', () => {
    expect(entries).toEqual([`u:${U}:reader`, `g:${G}:writer`]);
  });

  it('is order-insensitive (grants are sorted by code point here, never by a SQL collation)', () => {
    expect(aclVersion({ pageId: PAGE, restricted: true, entries })).toBe(
      aclVersion({ pageId: PAGE, restricted: true, entries: [...entries].reverse() }),
    );
  });

  it('changes with the page, the restricted flag, and any grant (added, removed, re-roled)', () => {
    const base = aclVersion({ pageId: PAGE, restricted: true, entries });
    expect(aclVersion({ pageId: SPACE.id, restricted: true, entries })).not.toBe(base);
    expect(aclVersion({ pageId: PAGE, restricted: false, entries })).not.toBe(base);
    expect(aclVersion({ pageId: PAGE, restricted: true, entries: entries.slice(1) })).not.toBe(base);
    expect(aclVersion({ pageId: PAGE, restricted: true, entries: [`u:${U}:writer`, entries[1]] })).not.toBe(base);
  });

  it('the page id and grantee ids are case-insensitive', () => {
    expect(aclVersion({ pageId: PAGE.toUpperCase(), restricted: true, entries })).toBe(
      aclVersion({ pageId: PAGE, restricted: true, entries }),
    );
    expect(aclEntry({ userId: U.toUpperCase(), groupId: null, role: 'reader' })).toBe(entries[0]);
  });

  it('byCodePoint is a code-point order (not UTF-16 units, not a locale collation)', () => {
    expect(['b', 'a', 'B', '\u{1F600}', '～'].sort(byCodePoint)).toEqual(['B', 'a', 'b', '～', '\u{1F600}']);
  });
});

describe('the compare', () => {
  const V = 'a'.repeat(64);

  it('absent → always proceeds; "*" → the resource exists; otherwise an exact match', () => {
    expect(versionMatches(undefined, null)).toBe(true);
    expect(versionMatches('*', V)).toBe(true);
    expect(versionMatches('*', null)).toBe(false);
    expect(versionMatches(V, V)).toBe(true);
    expect(versionMatches(V.toUpperCase(), V)).toBe(false); // opaque: no normalization of the token
    expect(versionMatches('b'.repeat(64), V)).toBe(false);
  });

  it('a stale version is a 412 precondition_failed, tagged as a refusal', () => {
    let err: unknown;
    try {
      assertExpectedVersion('b'.repeat(64), V);
    } catch (e) {
      err = e;
    }
    expect((err as HttpException).getStatus()).toBe(412);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'precondition_failed' });
    expect(refusalCodeOf(err)).toBe('precondition_failed');
  });

  it('a refusal tag never changes the HTTP body', () => {
    const plain = new ConflictException('x');
    const tagged = refusal(new ConflictException('x'), 'last_admin');
    expect(tagged.getResponse()).toEqual(plain.getResponse());
    expect(JSON.stringify(tagged)).toBe(JSON.stringify(plain));
    expect(refusalCodeOf(tagged)).toBe('last_admin');
    expect(refusalCodeOf(plain)).toBeUndefined();
  });

  it('expectedVersion: optional, 1..MAX chars', async () => {
    class Dto {
      @IsExpectedVersion() expectedVersion?: string;
    }
    const errs = async (v: unknown) => (await validate(plainToInstance(Dto, v === undefined ? {} : { expectedVersion: v }))).length;
    expect(await errs(undefined)).toBe(0);
    expect(await errs('*')).toBe(0);
    expect(await errs('x'.repeat(MAX_EXPECTED_VERSION_LENGTH))).toBe(0);
    expect(await errs('x'.repeat(MAX_EXPECTED_VERSION_LENGTH + 1))).toBe(1);
    expect(await errs('')).toBe(1);
    expect(await errs(7)).toBe(1);
  });
});

describe('busy engine', () => {
  it('maps exactly the Stage 1 conditional-ops SQLSTATEs to a 503 engine_busy', () => {
    expect([...VERSIONED_WRITE_BUSY_SQLSTATES].sort()).toEqual([...ENGINE_BUSY_SQLSTATES].sort());
    for (const code of VERSIONED_WRITE_BUSY_SQLSTATES) {
      const busy = asEngineBusy({ code });
      expect(busy?.getStatus()).toBe(503);
      expect(busy?.getResponse()).toMatchObject({ code: 'engine_busy' });
    }
    expect(asEngineBusy({ code: '23505' })).toBeNull();
    expect(asEngineBusy(new Error('x'))).toBeNull();
  });
});
