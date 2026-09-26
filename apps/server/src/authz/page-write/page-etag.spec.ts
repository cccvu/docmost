import { readFileSync } from 'fs';
import { join } from 'path';
import { pageEtagOpaque } from './page-etag';

/**
 * The page version token (#616) — a CROSS-SERVICE contract: the platform issues it as the page `ETag` (computeEtag
 * over the `/pages/info` JSON) and the fork's conditional page operations check it under the row lock. The vectors
 * were produced by an exact copy of the platform algorithm; services/platform/test/fixtures/page-etag-vectors.json is
 * an identical copy that the platform's own spec asserts. A red here means the two sides no longer agree and every
 * `If-Match` a client holds would 412 — fix the drift, never regenerate the fixture to make this pass.
 */
interface Vector {
  name: string;
  input: { updatedAt: string | null; lastUpdatedById: string | null; content?: unknown };
  opaque: string;
}

const VECTORS = JSON.parse(readFileSync(join(__dirname, 'page-etag-vectors.json'), 'utf8')) as Vector[];

/** The row as the fork reads it: the driver hands back `updatedAt` as a Date. */
const asRow = (input: Vector['input']) => ({
  ...input,
  updatedAt: input.updatedAt === null ? null : new Date(input.updatedAt),
});

describe('page-etag — the fork port of the platform page ETag', () => {
  it('carries the contract’s vector set (a gutted fixture must not pass vacuously)', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(6);
    const names = VECTORS.map((v) => v.name).join(' | ');
    for (const needle of ['null content', 'null lastUpdatedById', 'unsorted keys', 'unicode', 'marks']) {
      expect(names).toContain(needle);
    }
    for (const v of VECTORS) expect(v.opaque).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))('reproduces the platform vector from a DB row: %s', (_n, v) => {
    expect(pageEtagOpaque(asRow(v.input))).toBe(v.opaque);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))('reproduces it from the /pages/info JSON too: %s', (_n, v) => {
    expect(pageEtagOpaque(v.input)).toBe(v.opaque);
  });

  it('a Date and its ISO string are the same token (what Nest serializes is what the fork hashes)', () => {
    const d = new Date('2026-09-26T16:20:31.123Z');
    expect(pageEtagOpaque({ updatedAt: d, lastUpdatedById: 'u', content: null })).toBe(
      pageEtagOpaque({ updatedAt: d.toISOString(), lastUpdatedById: 'u', content: null }),
    );
  });

  it('changes when any of its three inputs changes, and not with content key order', () => {
    const base = { updatedAt: new Date('2026-01-01T00:00:00.000Z'), lastUpdatedById: 'u1', content: { a: 1, b: [1, 2] } };
    const t = pageEtagOpaque(base);
    expect(pageEtagOpaque({ ...base, updatedAt: new Date('2026-01-01T00:00:00.001Z') })).not.toBe(t);
    expect(pageEtagOpaque({ ...base, lastUpdatedById: 'u2' })).not.toBe(t);
    expect(pageEtagOpaque({ ...base, content: { a: 1, b: [2, 1] } })).not.toBe(t);
    expect(pageEtagOpaque({ ...base, content: { b: [1, 2], a: 1 } })).toBe(t);
  });
});
