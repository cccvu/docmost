/**
 * CCC integration — NOT upstream Docmost code (#716, ADR 0031 amendment).
 *
 * The API page-size cap: a GROWTH bound on what `/v1` (and the native `/api/pages/update`) may append to one page.
 *
 * Why only append/prepend: every single write is already bounded (1 MiB body; the converter's 100k nodes / 8 Mi
 * characters), so a replace or a create can never exceed the cap by itself — but appends accumulate without limit,
 * and every later write, load and store walks the WHOLE document on the event loop. A page grown by repeated small
 * appends to ~500k nodes made every subsequent write a multi-second block (#716 red review).
 *
 * The check: refuse an append/prepend when the page's stored Yjs state is already at or over the cap, measured with
 * `coalesce(octet_length(ydoc), 0)`. `octet_length` on a bytea reads the TOAST header's raw size (no detoast, no
 * decompression: `byteaoctetlen` → `toast_raw_datum_size`), so it is one indexed round trip with no copy of the page.
 * It runs BEFORE the content is parsed (no worker time, no main-thread walk), for keyed and unkeyed writes alike: a
 * keyed write over the cap is not parsed either, and the collab handler decides it (duplicate / stale / too large) on
 * the resident document without opening a connection. The write that crosses the cap is admitted (overshoot ≤ one
 * write). Concurrent appends cannot all pass together: on this process an append/prepend re-checks the size and
 * applies under a per-page growth lock (`withPageGrowthLock`), so the second sees the first's stored bytes. (Across two
 * tasks during a rolling deploy the lock is per process, so two appends on different tasks can still both pass.) A
 * replace always works, the escape hatch for a page that grew past the cap. Editor (websocket) edits are not capped:
 * this bounds API growth, it is not a security boundary. A DB error refuses the write; it never reads as 0.
 *
 * Unit: ydoc bytes bound node count AND string amplification together (a node count misses long repeated strings).
 * Default 3 MiB (`PAGE_MAX_YDOC_BYTES`, clamped to [1, 8] MiB): ~6× the largest real page measured (0.52 MB),
 * ~1.4× a Google-Docs-maximum page (`legit-990k`, 2.26 MB). Comparable products cap at ~1.5–5 MB of equivalent.
 *
 * #827 (ADR 0036 amendment): editor growth is now bounded too, but not here. The collab guard refuses a Step2/Update
 * frame larger than this cap before decoding it (`frame-too-large`), and counts per-page structure caps (structs,
 * client ids, children of one element, load walk steps: collab-ingress/doc-bounds.ts). A page past a cap is compacted
 * (page-write/compaction.ts): rebuilt from its visible content, which sheds the history these bytes also count. A page
 * still over a cap after compaction is `page-full`: the guard refuses editor growth, and the collab handler refuses an
 * API append/prepend with this file's `page_too_large` (`refusesGrowth`, seam #2); a replace still works. So the bytes
 * measured here can also shrink now, when a compaction rewrites the row's ydoc.
 */
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { sql } from 'kysely';
import type { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { OpSemaphore, OpSemaphoreTimeout } from './op-semaphore';

const MiB = 1024 * 1024;
export const PAGE_MAX_YDOC_BYTES_DEFAULT = 3 * MiB;
export const PAGE_MAX_YDOC_BYTES_FLOOR = 1 * MiB;
export const PAGE_MAX_YDOC_BYTES_CEILING = 8 * MiB;

/** `PAGE_MAX_YDOC_BYTES`: whole bytes, clamped to [1 MiB, 8 MiB]; unset, empty or junk is the 3 MiB default. */
export function pageMaxYdocBytesFromEnv(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return PAGE_MAX_YDOC_BYTES_DEFAULT;
  return Math.min(PAGE_MAX_YDOC_BYTES_CEILING, Math.max(PAGE_MAX_YDOC_BYTES_FLOOR, Math.floor(n)));
}

export const PAGE_MAX_YDOC_BYTES = pageMaxYdocBytesFromEnv(process.env.PAGE_MAX_YDOC_BYTES);

/** Only these operations accumulate; a replace (or a create) is bounded by the per-write caps. */
export function accumulates(operation: string | undefined): boolean {
  return operation === 'append' || operation === 'prepend';
}

const fmtMiB = (bytes: number) => `${Math.round((bytes / MiB) * 10) / 10} MiB`;

/** 422: the page is at the API size cap. Deterministic until the page shrinks: never retry unchanged. */
export class PageTooLargeException extends UnprocessableEntityException {
  constructor(limitBytes: number = PAGE_MAX_YDOC_BYTES) {
    super({
      message:
        `This page has reached the wiki's size limit (about ${fmtMiB(limitBytes)}), so the content was not added. ` +
        'Create a new page and link to it, or replace this page with shorter content.',
      code: 'page_too_large',
    });
  }
}

const logger = new Logger('PageSize');

/** The page's stored Yjs state size in bytes (0 when it has none or the row is gone). Throws on a DB error. */
export async function storedYdocBytes(db: KyselyDB | KyselyTransaction, pageId: string): Promise<number> {
  const row = await db
    .selectFrom('pages')
    .select(sql<number | string>`coalesce(octet_length(ydoc), 0)`.as('bytes'))
    .where('id', '=', pageId)
    .executeTakeFirst();
  if (!row) return 0;
  const bytes = Number(row.bytes);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`unreadable page size: ${String(row.bytes)}`);
  return bytes;
}

/**
 * Is this write an append/prepend to a page already at the cap? False for any other operation, without a query.
 * A DB error is a retryable 503 (nothing was applied), never "not over the cap". Logs `PAGE_TOO_LARGE` when over.
 */
export async function isOverPageCap(
  db: KyselyDB | KyselyTransaction | undefined,
  pageId: string,
  operation: string | undefined,
  limitBytes: number = PAGE_MAX_YDOC_BYTES,
): Promise<boolean> {
  if (!accumulates(operation)) return false;
  let bytes: number;
  try {
    if (!db) throw new Error('no database handle');
    bytes = await storedYdocBytes(db, pageId);
  } catch (err) {
    logger.warn(`page size check failed: page=${pageId} op=${operation}: ${(err as Error).message}; refused 503 engine_busy`);
    throw new ServiceUnavailableException({
      message: 'could not check the page size; the content was not applied — retry shortly',
      code: 'engine_busy',
    });
  }
  if (bytes < limitBytes) return false;
  logger.warn(`PAGE_TOO_LARGE page=${pageId} op=${operation} existing=${bytes} limit=${limitBytes}: refused 422 page_too_large`);
  return true;
}

/** Throw `PageTooLargeException` for an append/prepend to a page at the cap (the unkeyed and native paths). */
export async function assertPageCanGrow(
  db: KyselyDB | KyselyTransaction | undefined,
  pageId: string,
  operation: string | undefined,
  limitBytes: number = PAGE_MAX_YDOC_BYTES,
): Promise<void> {
  if (await isOverPageCap(db, pageId, operation, limitBytes)) throw new PageTooLargeException(limitBytes);
}

/**
 * How long an append/prepend waits for another append to the SAME page to finish its re-check, apply and store. Short:
 * the holder's work is one query, one Yjs insert and its stores (the parse happens before the lock). A wait that runs
 * out is a retryable 503 `engine_busy` — nothing was applied.
 */
export const PAGE_GROWTH_LOCK_WAIT_MS = 3_000;

/** One lock per page with a write in flight; an entry is dropped when its last holder or waiter leaves. */
const growthLocks = new Map<string, { sem: OpSemaphore; users: number }>();

/** Pages with a growth lock entry (tests: no leak once every write has finished). */
export function growthLockCount(): number {
  return growthLocks.size;
}

/**
 * Run `fn` (the size re-check and the apply) holding this page's growth lock, so concurrent appends/prepends to one page
 * are decided one after another against the bytes each predecessor stored — the cap's overshoot stays one write rather
 * than one write per concurrent caller. Any other operation runs `fn` directly. Per process (see the header).
 */
export async function withPageGrowthLock<T>(
  pageId: string,
  operation: string | undefined,
  fn: () => Promise<T>,
  waitMs: number = PAGE_GROWTH_LOCK_WAIT_MS,
): Promise<T> {
  if (!accumulates(operation)) return fn();
  let entry = growthLocks.get(pageId);
  if (!entry) {
    entry = { sem: new OpSemaphore(1, waitMs), users: 0 };
    growthLocks.set(pageId, entry);
  }
  entry.users++;
  try {
    let release: () => void;
    try {
      release = await entry.sem.acquire(waitMs);
    } catch (err) {
      if (!(err instanceof OpSemaphoreTimeout)) throw err;
      logger.warn(`page growth lock wait ran out: page=${pageId} op=${operation}; refused 503 engine_busy`);
      throw new ServiceUnavailableException({
        message: 'another write to this page is still being applied; the content was not applied — retry shortly',
        code: 'engine_busy',
      });
    }
    try {
      return await fn();
    } finally {
      release();
    }
  } finally {
    entry.users--;
    if (entry.users === 0 && growthLocks.get(pageId) === entry) growthLocks.delete(pageId);
  }
}

/**
 * The native write's apply (seam #121 `updatePageContent`): under the page's growth lock, re-check the cap (another
 * append may have stored since the entry check in `PageService.update`) and only then apply. Any other operation just
 * applies.
 */
export function applyWithinPageCap<T>(
  db: KyselyDB | KyselyTransaction | undefined,
  pageId: string,
  operation: string | undefined,
  apply: () => Promise<T>,
): Promise<T> {
  return withPageGrowthLock(pageId, operation, async () => {
    await assertPageCanGrow(db, pageId, operation);
    return apply();
  });
}
