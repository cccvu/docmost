import { BadRequestException } from '@nestjs/common';
import { isIsoInstant, parseSubCollectionQuery, SUB_COLLECTION_MAX_LIMIT } from './sub-collection-page.dto';

describe('parseSubCollectionQuery', () => {
  it('returns an empty page (unpaged) when nothing is supplied', () => {
    expect(parseSubCollectionQuery()).toEqual({});
    expect(parseSubCollectionQuery('', '', '')).toEqual({});
  });

  it('parses a valid limit', () => {
    expect(parseSubCollectionQuery('25')).toEqual({ limit: 25 });
  });

  it('rejects a non-integer / out-of-range limit', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', String(SUB_COLLECTION_MAX_LIMIT + 1)]) {
      expect(() => parseSubCollectionQuery(bad)).toThrow(BadRequestException);
    }
  });

  it('parses a full cursor with a limit', () => {
    expect(parseSubCollectionQuery('10', '2026-01-01T00:00:00.000Z', 'm-1')).toEqual({
      limit: 10,
      before: { createdAt: '2026-01-01T00:00:00.000Z', id: 'm-1' },
    });
  });

  it('rejects a half-supplied cursor (createdAt and id must come together)', () => {
    expect(() => parseSubCollectionQuery('10', '2026-01-01T00:00:00.000Z')).toThrow(BadRequestException);
    expect(() => parseSubCollectionQuery('10', undefined, 'm-1')).toThrow(BadRequestException);
  });

  it('rejects a cursor supplied without a limit (paging is opt-in on limit)', () => {
    expect(() => parseSubCollectionQuery(undefined, '2026-01-01T00:00:00.000Z', 'm-1')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-ISO beforeCreatedAt as a 400 — including a Date.parse-lenient-but-PG-invalid value', () => {
    expect(() => parseSubCollectionQuery('10', 'not-a-date', 'm-1')).toThrow(BadRequestException);
    // bare '2026' passes Date.parse but 500s at `::timestamptz`; the strict guard must reject it up front.
    expect(() => parseSubCollectionQuery('10', '2026', 'm-1')).toThrow(BadRequestException);
  });
});

describe('isIsoInstant', () => {
  it('accepts full ISO instants (what the platform sends via toISOString) and date-only', () => {
    expect(isIsoInstant('2026-01-01T00:00:00.000Z')).toBe(true);
    expect(isIsoInstant('2026-01-01T12:34:56+05:30')).toBe(true);
    expect(isIsoInstant('2026-01-01')).toBe(true);
  });
  it('rejects Date.parse-lenient-but-Postgres-invalid values', () => {
    expect(isIsoInstant('2026')).toBe(false);
    expect(isIsoInstant('2026-01')).toBe(false);
    expect(isIsoInstant('not-a-date')).toBe(false);
    expect(isIsoInstant('')).toBe(false);
  });
});
