import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ContentSearchDto } from './content-search.dto';
import { ContentCursorDto, ContentListDto, ContentSortDto } from './content-read.dto';

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
});
