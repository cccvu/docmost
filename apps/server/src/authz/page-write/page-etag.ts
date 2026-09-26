import { createHash } from 'crypto';
import { stableStringify } from './stable-hash';

/** The row fields the page version token is derived from — exactly what `/api/pages/info` serializes them from. */
export interface PageEtagMaterial {
  /** A `Date` from the database driver; Nest serializes it for `/pages/info` as the same ISO string. */
  updatedAt?: Date | string | null;
  lastUpdatedById?: string | null;
  content?: unknown;
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * The page version token, computed in the fork so a conditional page operation can compare it INSIDE the write's
 * transaction, under the row lock. It is a port of the platform's `computeEtag`
 * (services/platform/src/content/pages/pages.mapper.ts) over the `/api/pages/info` JSON, minus the quotes:
 *
 *   sha256hex(JSON.stringify([updatedAt, lastUpdatedById, stableStringify(content)]))
 *
 * `updatedAt` is the driver's `Date`; `JSON.stringify` calls its `toJSON`, which is the ISO string Nest writes into
 * the `/pages/info` response the platform hashes. `stableStringify` is the fork's copy in `stable-hash.ts`, which is
 * byte-for-byte the platform's `v1/stable-stringify.ts` (recursive key sort, cycles to null, `undefined` → `null`).
 *
 * UNLIKE the content digest in `stable-hash.ts`, this IS a cross-service contract: the platform issues the token (as
 * the page `ETag`) and the fork checks it. `page-etag-vectors.json` beside this file pins it, and an identical copy at
 * services/platform/test/fixtures/page-etag-vectors.json is asserted by the platform's spec — so a change on either
 * side reds a build instead of turning every `If-Match` a client holds into a 412.
 */
export function pageEtagOpaque(row: PageEtagMaterial): string {
  const material = JSON.stringify([
    row.updatedAt ?? null,
    row.lastUpdatedById ?? null,
    stableStringify(row.content),
  ]);
  return createHash('sha256').update(material).digest('hex');
}
