import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ContentSearchDto } from './content-search.dto';
import { ContentCursorDto, ContentListDto, ContentSortDto } from './content-read.dto';
import { MintSessionDto } from './mint-session.dto';
import { ProvisionUserDto } from './provision-user.dto';

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
  });
});
