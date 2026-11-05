/**
 * #699 — load the page content of an export only once it is known to fit. Fork-owned.
 *
 * A space export loaded every page's `content` in one query, and a subtree export did the same for the subtree, so a
 * large enough export exhausted the 1 GiB main heap: a process abort, a full outage at desired_count=1. The seam in
 * `ExportService` now selects the pages WITHOUT content, applies the permission filter, and hands the surviving pages
 * here. So the bound is over exactly what this caller may export (no signal about pages it cannot see), and over
 * exactly what is about to be loaded.
 *
 * Two queries decide it before the content query runs:
 *   1. `sum(pg_column_size(content))`: cheap (the stored size; no detoasting). Stored size stays below the text the
 *      driver receives (measured, PG 18: ≤ ~0.6× even for 2 KB pages, ~0.36× for realistic large ones), so past the
 *      bound here is past it for real: refused without making Postgres decompress a huge space.
 *   2. `sum(octet_length(content::text))`: the JSON text the driver will parse, i.e. what the heap pays for.
 *      pglz stores realistic pages ~2.7× and repetitive ones ~60× smaller (measured, PG 18), so step 1 alone can
 *      be beaten by compressible content. This costs Postgres roughly what the load itself would (~3.6 ms per MiB
 *      measured), and at most ~60× the step-1 bound for adversarial content.
 * The page count is checked first: a zip32 archive lists at most 65,535 entries.
 */
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { exportLimits, ExportLimits, ExportTooLargeException } from './export-limits';

export interface ExportContentSource {
  /** Stored and text sizes of `content` over `ids`, as two separate steps so a huge stored size never pays step 2. */
  storedBytes(ids: string[]): Promise<number>;
  textBytes(ids: string[]): Promise<number>;
  contents(ids: string[]): Promise<Array<{ id: string; content: unknown }>>;
}

/** The real source: the fork's Kysely (CamelCasePlugin; postgres.js parses int8 to number). */
export function kyselyContentSource(db: Kysely<any>): ExportContentSource {
  const sum = async (expr: ReturnType<typeof sql>, ids: string[]) => {
    const row = await db
      .selectFrom('pages')
      .select(sql<string | number>`coalesce(sum(${expr}), 0)`.as('bytes'))
      .where(sql<boolean>`id = any(${ids}::uuid[])`)
      .executeTakeFirst();
    return Number(row?.bytes ?? 0);
  };
  return {
    storedBytes: (ids) => sum(sql`pg_column_size(content)`, ids),
    textBytes: (ids) => sum(sql`octet_length(content::text)`, ids),
    contents: (ids) =>
      db
        .selectFrom('pages')
        .select(['id', 'content'])
        .where(sql<boolean>`id = any(${ids}::uuid[])`)
        .execute() as Promise<Array<{ id: string; content: unknown }>>,
  };
}

/**
 * Check the export set against the content bound, then set `content` on each page in place (order and objects kept).
 * Throws 422 `export_too_large` before loading anything when it does not fit.
 */
export async function loadExportContent<T extends { id: string }>(
  source: ExportContentSource | Kysely<any>,
  pages: T[],
  limits: Pick<ExportLimits, 'contentBytes' | 'maxEntries'> = exportLimits(),
): Promise<Array<T & { content: unknown }>> {
  const src: ExportContentSource = 'storedBytes' in source ? source : kyselyContentSource(source as Kysely<any>);
  const loaded = pages as Array<T & { content: unknown }>;
  if (pages.length === 0) return loaded;
  if (pages.length > limits.maxEntries) throw new ExportTooLargeException('pages', pages.length, limits.maxEntries);

  const ids = pages.map((p) => p.id);
  const stored = await src.storedBytes(ids);
  if (stored > limits.contentBytes) throw new ExportTooLargeException('content', stored, limits.contentBytes);
  const text = await src.textBytes(ids);
  if (text > limits.contentBytes) throw new ExportTooLargeException('content', text, limits.contentBytes);

  const byId = new Map((await src.contents(ids)).map((r) => [r.id, r.content]));
  for (const p of loaded) p.content = byId.get(p.id) ?? null;
  return loaded;
}
