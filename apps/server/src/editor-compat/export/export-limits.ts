/**
 * #699 — the bounds of one native export (`POST /api/pages/export`, `POST /api/spaces/export`). Fork-owned.
 *
 * An export used to read every attachment whole into off-heap Buffers that JSZip kept until the response ended, so
 * ~1.5–2 GiB of attachments OOM-killed the 4 GB task, and a big space's page content could exhaust the 1 GiB main heap.
 * Both are full outages at desired_count=1. Attachments now stream (export-stream.ts), so their bytes no longer
 * reach the heap, and what is left is bounded here. Every bound is decided BEFORE the first byte is sent, except the
 * two that cannot be: the streamed-bytes backstop (rows with a NULL `file_size`) and the wall-clock cap.
 *
 *   - attachmentBytes (EXPORT_ATTACHMENTS_MAX_BYTES, default 2 GiB): the sum of `attachments.file_size` over the
 *     attachments the export writes, counted once per archive path. JSZip 3.10.1 writes no ZIP64 (4-byte sizes and
 *     offsets, ZipFileWorker.js:277-284), so an archive past 4 GiB comes out corrupt without an error; the value is
 *     clamped below 3.5 GiB to leave room for the pages, the headers and the central directory.
 *   - maxEntries 65,000: the zip32 end record has a 2-byte entry count (≤ 65,535), so more entries corrupt it too.
 *   - contentBytes (EXPORT_CONTENT_MAX_BYTES, default 12 MiB, clamped to 16 MiB, #716): the page content an export loads,
 *     measured as the JSON text the driver parses (`octet_length(content::text)`). Measured (Node 24, realistic
 *     ProseMirror pages): the parsed documents retain ~1.9 B of heap per text byte and the HTML each page becomes
 *     another ~1.9 B, all held until the archive has streamed, so 16 MiB costs ~60 MiB of heap and the 8 exports the
 *     admission allows at once stay under ~0.5 GiB of the 1 GiB heap. That holds for Markdown only because the
 *     export converts it with the jsdom window released (html-to-markdown.ts): Turndown otherwise kept every page's
 *     DOM, ~150× its HTML, until the whole export had converted. `pg_column_size` alone is not a heap bound:
 *     pglz stores realistic pages at ~2.7× and repetitive ones at ~60× smaller (measured, PG 18), so it is only the
 *     cheap first refusal (export-content.ts). #716: the ceiling was 64 MiB, ~243 MiB of heap per export and ~1.9 GiB
 *     for the 8 the admission allows, against a 1 GiB heap; 16 MiB keeps that sum under ~0.5 GiB. The default is set
 *     by what the conversion worker can serialize inside `buildMs`: Markdown, the slower format, runs at ~2.8 MiB of
 *     stored JSON a second on a laptop (WS5 step 0: 2.69 MB in ~0.95 s), ~1.1 MiB/s on Graviton and ~0.55 MiB/s under
 *     CFS contention, so 45 s × 0.55 MiB/s × 0.5 (half the window, for queueing behind writes and the attachment
 *     prechecks) ≈ 12 MiB. Past it is the cheap 422 before any content loads, not a 503 after 45 s of work.
 *   - buildMs 45 s (#716): from the start of the export (the top of `exportPages`/`exportSpace`, so the subtree read,
 *     the PDP filter and the content load count too) to the end of `seal()`, everything before the first byte (the
 *     page serializations and the attachment prechecks), under the platform's 50 s time-to-first-byte and the ALB's
 *     60 s idle timeout. Past it is 503 `export_timeout` with a build-phase message (export-conversion.ts). A client
 *     that disconnects stops the build.
 *   - singlePageBuildMs 9 s (#716): the same, for a single-page export (no zip), which the platform relays inside its
 *     20 s content-write timeout: the page's worker wait is cut to what is left of 9 s, and a conversion that has
 *     started runs to at most its 7 s deadline (+ a 3.5 s reload credit), so the engine answers within ~19.5 s.
 *   - existsGlobal 16 (#716): storage HEADs in flight across ALL exports in the process (each export still runs at most
 *     `existsConcurrency`). A HEAD's slot is taken BEFORE its storage timeout starts, so a queued HEAD is never a
 *     spurious 503: 8 admitted exports × 8 used to be 64 HEADs against the S3 client's 50 sockets.
 *   - maxDurationMs (EXPORT_MAX_DURATION_MS, default 30 min): from the start of the export to the end of the archive.
 *     A client that reads slowly holds its admission slot and one storage socket; past this the export is aborted.
 *   - storageTimeoutMs (EXPORT_STORAGE_TIMEOUT_MS, default 10 s): the most one storage call may take to answer, an
 *     `exists()` before the first byte or the open of an attachment's object while streaming. The S3 client sets no
 *     request timeout, so a hung HEAD would otherwise hold the request, and its admission slot, indefinitely. Past it
 *     the export fails like any other storage error (503 `export_storage_unavailable` before the first byte).
 *   - existsConcurrency 8: storage HEADs in flight while missing objects are decided (the S3 pool has 50 sockets,
 *     shared with every attachment download and upload).
 */
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface ExportLimits {
  attachmentBytes: number;
  maxEntries: number;
  contentBytes: number;
  maxDurationMs: number;
  storageTimeoutMs: number;
  existsConcurrency: number;
  /** #716: the build deadline, from the export's start to the end of `seal()`. */
  buildMs: number;
  /** #716: the build deadline of a single-page export (no zip). */
  singlePageBuildMs: number;
}

/** Hard ceilings an env value is clamped to. */
export const EXPORT_LIMIT_CEILINGS = Object.freeze({
  attachmentBytes: 3.5 * GiB - 1,
  maxEntries: 65_000,
  contentBytes: 16 * MiB, // #716: was 64 MiB (~1.9 GiB of heap for 8 exports against a 1 GiB heap)
  maxDurationMs: 6 * 60 * 60 * 1000,
  storageTimeoutMs: 5 * 60 * 1000,
});

export const EXPORT_LIMIT_DEFAULTS: Readonly<ExportLimits> = Object.freeze({
  attachmentBytes: 2 * GiB,
  maxEntries: 65_000,
  contentBytes: 12 * MiB, // #716: what the worker serializes in half of buildMs under contention (above)
  maxDurationMs: 30 * 60 * 1000,
  storageTimeoutMs: 10_000,
  existsConcurrency: 8,
  buildMs: 45_000,
  singlePageBuildMs: 9_000,
});

/** #716: storage HEADs in flight across every export in the process (export-attachment-plan.ts). */
export const EXPORT_EXISTS_GLOBAL = 16;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, ceiling: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    new Logger('Export').warn(`${name}=${raw} is not a positive integer; using the default ${fallback}`);
    return fallback;
  }
  return Math.min(n, ceiling);
}

/** Read once per export (cheap), so ops can tune without a code change and a test can pin a small value. */
export function exportLimits(env: NodeJS.ProcessEnv = process.env): ExportLimits {
  return {
    attachmentBytes: envInt(env, 'EXPORT_ATTACHMENTS_MAX_BYTES', EXPORT_LIMIT_DEFAULTS.attachmentBytes, EXPORT_LIMIT_CEILINGS.attachmentBytes),
    maxEntries: EXPORT_LIMIT_DEFAULTS.maxEntries,
    contentBytes: envInt(env, 'EXPORT_CONTENT_MAX_BYTES', EXPORT_LIMIT_DEFAULTS.contentBytes, EXPORT_LIMIT_CEILINGS.contentBytes),
    maxDurationMs: envInt(env, 'EXPORT_MAX_DURATION_MS', EXPORT_LIMIT_DEFAULTS.maxDurationMs, EXPORT_LIMIT_CEILINGS.maxDurationMs),
    storageTimeoutMs: envInt(env, 'EXPORT_STORAGE_TIMEOUT_MS', EXPORT_LIMIT_DEFAULTS.storageTimeoutMs, EXPORT_LIMIT_CEILINGS.storageTimeoutMs),
    existsConcurrency: EXPORT_LIMIT_DEFAULTS.existsConcurrency,
    buildMs: EXPORT_LIMIT_DEFAULTS.buildMs,
    singlePageBuildMs: EXPORT_LIMIT_DEFAULTS.singlePageBuildMs,
  };
}

const mib = (n: number) => `${Math.ceil(n / MiB).toLocaleString('en-US')} MiB`;

export type ExportTooLargeReason = 'attachments' | 'entries' | 'content' | 'pages' | 'page';

/** 422: deterministic for the same export — narrow it, never retry it unchanged. */
export class ExportTooLargeException extends UnprocessableEntityException {
  constructor(
    readonly reason: ExportTooLargeReason,
    total: number,
    limit: number,
  ) {
    super({ message: ExportTooLargeException.describe(reason, total, limit), code: 'export_too_large' });
  }

  static describe(reason: ExportTooLargeReason, total: number, limit: number): string {
    switch (reason) {
      case 'attachments':
        return (
          `This export is too large: its attachments total ${mib(total)}, above the ${mib(limit)} limit. ` +
          'Export without attachments, or export a smaller subtree.'
        );
      case 'entries':
        return (
          `This export is too large: it would hold ${total.toLocaleString('en-US')} files and folders, above the ` +
          `${limit.toLocaleString('en-US')} a zip archive can list. Export a smaller subtree, or export without attachments.`
        );
      case 'pages':
        return (
          `This export is too large: it has ${total.toLocaleString('en-US')} pages, above the ` +
          `${limit.toLocaleString('en-US')} a zip archive can list. Export a smaller subtree.`
        );
      case 'content':
        return (
          `This export is too large: its page content totals ${mib(total)}, above the ${mib(limit)} limit. ` +
          'Export a smaller subtree.'
        );
      case 'page':
        // #716: one page did not serialize within the conversion worker's bounds (deadline, heap, output size).
        // Only a Markdown export can be helped by switching to HTML (HTML skips the Markdown step); `limit` is 1 then.
        return (
          'A page in this export is too large or complex to convert within the limits. ' +
          (limit === 1 ? 'Export it as HTML, or export a smaller page.' : 'Split it into smaller pages and export those.')
        );
    }
  }

  /** #716: one page past the conversion worker's bounds (the totals are not meaningful for it). */
  /** `format`: the export's format; only a Markdown export is told to try HTML instead. */
  static page(format?: string): ExportTooLargeException {
    return new ExportTooLargeException('page', 0, format === 'markdown' ? 1 : 0);
  }
}

/**
 * 503 (#716): the export was still converting pages or checking attachments `buildMs` after its request started, so it
 * was stopped before the first byte, rather than outlive the load balancer's idle timeout. Retryable once the engine
 * is less busy; a smaller subtree, or HTML, builds faster.
 */
export class ExportBuildTimeoutException extends ServiceUnavailableException {
  constructor(limitMs: number) {
    super({
      message:
        `The export could not be prepared within ${Math.round(limitMs / 1000)} seconds and was stopped. ` +
        'Try again shortly, export a smaller subtree, or export as HTML.',
      code: 'export_timeout',
    });
  }
}

/**
 * 503: storage could not answer for an attachment (an error other than "no such object"), so the export was stopped
 * rather than shipped without it. Retryable. The storage error itself is logged, never sent (it can name the bucket).
 */
export class ExportStorageException extends ServiceUnavailableException {
  constructor() {
    super({
      message:
        'An attachment could not be read from storage, so the export was stopped. Try again shortly, or export without attachments.',
      code: 'export_storage_unavailable',
    });
  }
}

/** 503: the export ran past EXPORT_MAX_DURATION_MS and was stopped. */
export class ExportTimeoutException extends ServiceUnavailableException {
  constructor(limitMs: number) {
    super({
      message: `The export took longer than ${Math.round(limitMs / 60_000)} minutes and was stopped. Export a smaller subtree, or export without attachments.`,
      code: 'export_timeout',
    });
  }
}

/** A storage call that did not answer within `storageTimeoutMs`. A storage failure, never "no such object". */
export class StorageTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = 'StorageTimeoutError';
  }
}

/**
 * Race a storage call against `ms`. The call itself cannot be cancelled (the storage interface takes no signal), so a
 * late answer is ignored by the caller; `onLate` releases what it brings (an opened stream).
 */
export function withStorageTimeout<T>(call: Promise<T>, ms: number, what: string, onLate?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new StorageTimeoutError(what, ms));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  call.then(
    (v) => {
      if (timedOut) onLate?.(v);
    },
    () => undefined, // a late rejection is moot; never unhandled
  );
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}
