import { BadRequestException } from '@nestjs/common';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Opt-in keyset paging for the bare sub-collection reads (space members, page ACL grants). These reads are
 * unbounded arrays today; a client opts into paging by sending `limit` (+ optionally a `before` cursor). When
 * `limit` is absent the read stays unpaged (returns all — the backward-compatible default an un-updated
 * platform relies on across the C9 submodule bump). The bound is `{ createdAt, id }` walked ascending.
 */
export const SUB_COLLECTION_MAX_LIMIT = 200;

export interface SubCollectionPage {
  limit?: number;
  before?: { createdAt: string; id: string };
}

/**
 * A strict-enough ISO-8601 instant guard for a keyset timestamp bound: requires a full YYYY-MM-DD date (time
 * optional), so a `Date.parse`-lenient-but-Postgres-invalid value like bare `'2026'` is rejected HERE (a 400)
 * instead of 500-ing at the `::timestamptz` cast. The platform always sends `Date.prototype.toISOString()`
 * output, which passes; this guards a direct service-bridge caller. Shared with the content keyset builder.
 */
export function isIsoInstant(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) &&
    !Number.isNaN(Date.parse(s))
  );
}

/**
 * Parse the `{ limit, beforeCreatedAt, beforeId }` query triple into a SubCollectionPage. Undefined `limit`
 * → unpaged (return all). A malformed limit, a half-supplied cursor, a cursor without a limit, or a
 * non-parseable timestamp is a 400 (never a 500 at the SQL cast).
 */
export function parseSubCollectionQuery(
  rawLimit?: string,
  beforeCreatedAt?: string,
  beforeId?: string,
): SubCollectionPage {
  const page: SubCollectionPage = {};
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > SUB_COLLECTION_MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer in [1, ${SUB_COLLECTION_MAX_LIMIT}]`);
    }
    page.limit = n;
  }
  const hasCreatedAt = beforeCreatedAt !== undefined && beforeCreatedAt !== '';
  const hasId = beforeId !== undefined && beforeId !== '';
  if (hasCreatedAt !== hasId) {
    throw new BadRequestException('beforeCreatedAt and beforeId must be supplied together');
  }
  if (hasCreatedAt && hasId) {
    if (page.limit === undefined) {
      throw new BadRequestException('a cursor (beforeCreatedAt/beforeId) requires limit');
    }
    if (!isIsoInstant(beforeCreatedAt as string)) {
      throw new BadRequestException('beforeCreatedAt must be an ISO-8601 timestamp');
    }
    page.before = { createdAt: beforeCreatedAt as string, id: beforeId as string };
  }
  return page;
}
