import { BadRequestException } from '@nestjs/common';
import { parseSubCollectionQuery, SUB_COLLECTION_MAX_LIMIT } from './sub-collection-page.dto';

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

  it('rejects a non-ISO beforeCreatedAt (a 400, not a 500 at the cast)', () => {
    expect(() => parseSubCollectionQuery('10', 'not-a-date', 'm-1')).toThrow(BadRequestException);
  });
});
