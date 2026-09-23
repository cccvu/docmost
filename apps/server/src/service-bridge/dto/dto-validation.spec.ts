import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ContentSearchDto } from './content-search.dto';
import { ContentCursorDto, ContentListDto, ContentSortDto } from './content-read.dto';
import { MintSessionDto } from './mint-session.dto';
import { ProvisionUserDto } from './provision-user.dto';
import { SessionExternalIdDto } from './session-external-id.dto';
import { LookupUsersDto } from './lookup-users.dto';
import { UpdateSpaceMemberDto } from './space-admin.dto';
import { PageAuthzStateDto } from './page-authz-state.dto';

/**
 * These DTOs' class-validator decorators are the load-bearing input guard for the new service-bridge ops (the
 * global ValidationPipe enforces them at the edge). The wire/spy specs never run them through validation, so
 * without this spec, removing a constraint (`@Max(100)`, `@IsUUID`, `@IsIn`, `@IsNotEmpty`, `@IsISO8601`, …)
 * would red nothing. Here we run each DTO through `validate()` so a dropped constraint fails a test.
 */
const errCount = async <T extends object>(cls: new () => T, obj: unknown): Promise<number> =>
  (await validate(plainToInstance(cls, obj as any))).length;

// A valid RFC-4122 v4 UUID (version nibble 4, variant nibble 8) — @IsUUID rejects a wrong-variant value.
const UUID = '00000000-0000-4000-8000-000000000001';

describe('service-bridge DTO validation (constraints are load-bearing)', () => {
  // #545: the page-state read. Mode exclusivity is the service's (a 400 there); these are the field constraints.
  describe('PageAuthzStateDto', () => {
    it('accepts 1..500 uuids, and a limit of 1..500 with an optional subtree root and keyset position', async () => {
      expect(await errCount(PageAuthzStateDto, { pageIds: [UUID] })).toBe(0);
      expect(await errCount(PageAuthzStateDto, { pageIds: Array.from({ length: 500 }, () => UUID) })).toBe(0);
      expect(await errCount(PageAuthzStateDto, { limit: 500, subtreeRootId: UUID, after: UUID })).toBe(0);
      expect(await errCount(PageAuthzStateDto, { limit: 1 })).toBe(0);
    });
    it('rejects an empty or over-500 id list, a non-uuid id / root / after, and an out-of-range limit', async () => {
      expect(await errCount(PageAuthzStateDto, { pageIds: [] })).toBeGreaterThan(0);
      expect(await errCount(PageAuthzStateDto, { pageIds: Array.from({ length: 501 }, () => UUID) })).toBeGreaterThan(0);
      expect(await errCount(PageAuthzStateDto, { pageIds: ['nope'] })).toBeGreaterThan(0);
      expect(await errCount(PageAuthzStateDto, { limit: 5, subtreeRootId: 'nope' })).toBeGreaterThan(0);
      expect(await errCount(PageAuthzStateDto, { limit: 5, after: 'nope' })).toBeGreaterThan(0);
      expect(await errCount(PageAuthzStateDto, { limit: 0 })).toBeGreaterThan(0);
      expect(await errCount(PageAuthzStateDto, { limit: 501 })).toBeGreaterThan(0);
    });
  });

  describe('ContentSearchDto', () => {
    it('accepts a valid search request', async () => {
      expect(await errCount(ContentSearchDto, { userId: UUID, query: 'hello', limit: 25, offset: 0 })).toBe(0);
    });
    it('rejects a non-uuid or missing userId', async () => {
      expect(await errCount(ContentSearchDto, { userId: 'nope', query: 'x' })).toBeGreaterThan(0);
      expect(await errCount(ContentSearchDto, { query: 'x' })).toBeGreaterThan(0);
    });
    it('rejects an empty or over-long query', async () => {
      expect(await errCount(ContentSearchDto, { userId: UUID, query: '' })).toBeGreaterThan(0);
      expect(await errCount(ContentSearchDto, { userId: UUID, query: 'a'.repeat(1025) })).toBeGreaterThan(0);
    });
    it('rejects a limit over 100 / below 1 and a negative offset', async () => {
      expect(await errCount(ContentSearchDto, { userId: UUID, query: 'x', limit: 101 })).toBeGreaterThan(0);
      expect(await errCount(ContentSearchDto, { userId: UUID, query: 'x', limit: 0 })).toBeGreaterThan(0);
      expect(await errCount(ContentSearchDto, { userId: UUID, query: 'x', offset: -1 })).toBeGreaterThan(0);
    });
  });

  describe('ContentSortDto', () => {
    it('accepts the allowlisted fields + directions', async () => {
      expect(await errCount(ContentSortDto, { field: 'updatedAt', direction: 'desc' })).toBe(0);
      expect(await errCount(ContentSortDto, { field: 'title', direction: 'asc' })).toBe(0);
    });
    it('rejects an out-of-allowlist field or a bad direction', async () => {
      expect(await errCount(ContentSortDto, { field: 'password', direction: 'asc' })).toBeGreaterThan(0);
      expect(await errCount(ContentSortDto, { field: 'title', direction: 'sideways' })).toBeGreaterThan(0);
    });
  });

  describe('ContentCursorDto', () => {
    it('accepts a legacy timestamp cursor and a generic value cursor', async () => {
      expect(await errCount(ContentCursorDto, { updatedAt: '2026-01-01T00:00:00.000Z', id: 'x' })).toBe(0);
      expect(await errCount(ContentCursorDto, { value: 'Roadmap', id: 'x' })).toBe(0);
    });
    it('rejects a missing id or a non-ISO updatedAt', async () => {
      expect(await errCount(ContentCursorDto, { value: 'x' })).toBeGreaterThan(0);
      expect(await errCount(ContentCursorDto, { updatedAt: 'not-a-date', id: 'x' })).toBeGreaterThan(0);
    });
  });

  describe('ContentListDto (filters + nested sort/cursor)', () => {
    it('accepts a valid filtered + sorted request', async () => {
      expect(
        await errCount(ContentListDto, {
          ids: [UUID],
          limit: 50,
          titleContains: 'road',
          sort: { field: 'title', direction: 'asc' },
          before: { value: 'road', id: 'x' },
        }),
      ).toBe(0);
    });
    it('rejects a non-uuid id in the set and an over-cap limit', async () => {
      expect(await errCount(ContentListDto, { ids: ['nope'], limit: 10 })).toBeGreaterThan(0);
      expect(await errCount(ContentListDto, { ids: [UUID], limit: 101 })).toBeGreaterThan(0);
    });
    it('validates the NESTED sort object (an invalid sort field fails)', async () => {
      expect(
        await errCount(ContentListDto, { ids: [UUID], limit: 10, sort: { field: 'evil', direction: 'asc' } }),
      ).toBeGreaterThan(0);
    });
  });

  /**
   * Issue #50 — the shadow-session DTOs. `externalId` is interpolated into the synthetic email
   * (`<externalId>@shadow.wiki-v2.internal`), so its charset is the no-injection boundary: an `@`, a
   * space, or a `/` must never reach the derivation, and neither may an over-long value overflow the
   * (varchar) email column. `name` is display-only but length-bounded for the same reason.
   */
  describe('ProvisionUserDto (externalId charset + name length are the no-injection boundary)', () => {
    it('T-035: accepts platform-style identity ids (uuid / opaque id charset)', async () => {
      expect(await errCount(ProvisionUserDto, { externalId: UUID })).toBe(0);
      expect(await errCount(ProvisionUserDto, { externalId: 'AbC-123_x.y+z', name: 'Alice' })).toBe(0);
      expect(await errCount(ProvisionUserDto, { externalId: 'a'.repeat(128) })).toBe(0);
      expect(await errCount(ProvisionUserDto, { externalId: 'a'.repeat(128), name: 'n'.repeat(255) })).toBe(0);
    });

    it('T-035: rejects any externalId that could break out of the derived local part', async () => {
      const hostile = [
        'a@b', // injects a domain boundary
        'a b', // whitespace
        'a/b',
        'a\\b',
        'a\nb',
        'a@shadow.wiki-v2.internal', // a full address
        '', // empty
        'a'.repeat(129), // over the local-part cap
        'héllo', // non-ASCII
      ];
      for (const externalId of hostile) {
        expect(await errCount(ProvisionUserDto, { externalId })).toBeGreaterThan(0);
      }
      expect(await errCount(ProvisionUserDto, {})).toBeGreaterThan(0); // missing
    });

    it('T-035: rejects an over-long display name and accepts an omitted one', async () => {
      expect(await errCount(ProvisionUserDto, { externalId: UUID, name: 'n'.repeat(256) })).toBeGreaterThan(0);
      expect(await errCount(ProvisionUserDto, { externalId: UUID })).toBe(0);
    });
  });

  describe('MintSessionDto (same no-injection boundary as provisioning)', () => {
    it('T-035: accepts a uuid and rejects a domain-bearing externalId', async () => {
      expect(await errCount(MintSessionDto, { externalId: UUID })).toBe(0);
      expect(await errCount(MintSessionDto, { externalId: 'a@b' })).toBeGreaterThan(0);
      expect(await errCount(MintSessionDto, { externalId: 'a'.repeat(129) })).toBeGreaterThan(0);
      expect(await errCount(MintSessionDto, {})).toBeGreaterThan(0);
    });

    // #330: clientIp is OPTIONAL and deliberately NOT @IsIP-validated at the DTO — a malformed value must not
    // 400 a sign-in (the service degrades it to NULL). Only the length bound is enforced here, so an abusive
    // value can't reach the row; syntactic IP validation is the service's job (trustedClientIp).
    it('#330: clientIp is optional, tolerates non-IP strings, but is length-bounded at 45', async () => {
      expect(await errCount(MintSessionDto, { externalId: UUID })).toBe(0); // omitted is fine
      expect(await errCount(MintSessionDto, { externalId: UUID, clientIp: '203.0.113.7' })).toBe(0);
      expect(await errCount(MintSessionDto, { externalId: UUID, clientIp: '2001:db8::1' })).toBe(0);
      // A non-address string still validates at the DTO (the service maps it to NULL, never a 400/500).
      expect(await errCount(MintSessionDto, { externalId: UUID, clientIp: 'not-an-ip' })).toBe(0);
      // At-limit VALID case: the longest legal IPv6 text (IPv4-mapped) is exactly 45 chars and MUST pass —
      // pins @MaxLength(45) so nobody tightens it below 45 and starts 400-ing long-IPv6 sign-ins undetected.
      const maxIpv6 = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
      expect(maxIpv6.length).toBe(45);
      expect(await errCount(MintSessionDto, { externalId: UUID, clientIp: maxIpv6 })).toBe(0);
      // Over the 45-char IPv6-text bound → rejected.
      expect(await errCount(MintSessionDto, { externalId: UUID, clientIp: 'a'.repeat(46) })).toBeGreaterThan(0);
    });
  });

  /*
   * #455 — the session-lifecycle DTO for POST /api/service/session/{revoke,restore}. Same no-injection
   * boundary as provisioning/minting: `externalId` is interpolated into the synthetic shadow email, so the
   * charset guard is the security boundary that stops a caller from deactivating an arbitrary/real/privileged
   * account. Only the wire/pg specs exercise these ops and they bypass the DTO (pg) or send clean input
   * (client), so WITHOUT this block, dropping the @Matches guard would red nothing.
   */
  describe('SessionExternalIdDto (revoke/restore — externalId charset is the no-injection boundary)', () => {
    it('T-035: accepts platform-style identity ids (uuid / opaque id charset)', async () => {
      expect(await errCount(SessionExternalIdDto, { externalId: UUID })).toBe(0);
      expect(await errCount(SessionExternalIdDto, { externalId: 'AbC-123_x.y+z' })).toBe(0);
      expect(await errCount(SessionExternalIdDto, { externalId: 'a'.repeat(128) })).toBe(0);
    });

    it('T-035: rejects any externalId that could break out of the derived shadow-email local part', async () => {
      const hostile = [
        'a@b', // injects a domain boundary
        'a b', // whitespace
        'a/b',
        'a\\b',
        'a\nb',
        'a@shadow.wiki-v2.internal', // a full address
        '', // empty
        'a'.repeat(129), // over the 128-char cap
        'héllo', // non-ASCII
      ];
      for (const externalId of hostile) {
        expect(await errCount(SessionExternalIdDto, { externalId })).toBeGreaterThan(0);
      }
      expect(await errCount(SessionExternalIdDto, {})).toBeGreaterThan(0); // missing
    });
  });

  // #486: `POST /api/service/users/lookup` derives a shadow email from EACH id, so the same charset guard applies
  // element-wise; the batch is bounded (1..256, the /v1 revoke cap).
  describe('LookupUsersDto (each externalId is the no-injection boundary; bounded batch)', () => {
    it('accepts 1..256 well-formed ids', async () => {
      expect(await errCount(LookupUsersDto, { externalIds: [UUID] })).toBe(0);
      expect(await errCount(LookupUsersDto, { externalIds: Array.from({ length: 256 }, (_, i) => `id-${i}`) })).toBe(0);
    });

    it('rejects an empty, oversized, missing or hostile batch', async () => {
      expect(await errCount(LookupUsersDto, { externalIds: [] })).toBeGreaterThan(0);
      expect(await errCount(LookupUsersDto, { externalIds: Array.from({ length: 257 }, (_, i) => `id-${i}`) })).toBeGreaterThan(0);
      expect(await errCount(LookupUsersDto, {})).toBeGreaterThan(0);
      expect(await errCount(LookupUsersDto, { externalIds: 'alice' })).toBeGreaterThan(0);
      for (const bad of ['a@b', 'a b', '', 'a@shadow.wiki-v2.internal', 'héllo']) {
        expect(await errCount(LookupUsersDto, { externalIds: [UUID, bad] })).toBeGreaterThan(0);
      }
    });
  });

  /**
   * #486 rule M: the member re-role must name its actor so the fork can refuse a self-raising write. The field
   * is REQUIRED (fail closed): a caller that omits it gets a 400, never an unchecked write.
   */
  describe('UpdateSpaceMemberDto (actorExternalId is required — rule M fails closed)', () => {
    it('accepts a role plus a well-formed actorExternalId', async () => {
      expect(await errCount(UpdateSpaceMemberDto, { role: 'writer', actorExternalId: UUID })).toBe(0);
    });

    it('rejects a missing, empty or hostile actorExternalId, and an unknown role', async () => {
      expect(await errCount(UpdateSpaceMemberDto, { role: 'writer' })).toBeGreaterThan(0);
      for (const actorExternalId of ['', 'a@b', 'a b', 'a'.repeat(129)]) {
        expect(await errCount(UpdateSpaceMemberDto, { role: 'writer', actorExternalId })).toBeGreaterThan(0);
      }
      expect(await errCount(UpdateSpaceMemberDto, { role: 'owner', actorExternalId: UUID })).toBeGreaterThan(0);
    });
  });
});
