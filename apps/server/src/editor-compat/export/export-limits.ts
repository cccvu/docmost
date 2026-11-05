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
 *   - contentBytes (EXPORT_CONTENT_MAX_BYTES, default 16 MiB, clamped to 64 MiB): the page content an export loads,
 *     measured as the JSON text the driver parses (`octet_length(content::text)`). Measured (Node 24, realistic
 *     ProseMirror pages): the parsed documents retain ~1.9 B of heap per text byte and the HTML each page becomes
 *     another ~1.9 B, all held until the archive has streamed, so 16 MiB costs ~60 MiB of heap and the 8 exports the
 *     admission allows at once stay under ~0.5 GiB of the 1 GiB heap. That holds for Markdown only because the
 *     export converts it with the jsdom window released (html-to-markdown.ts): Turndown otherwise kept every page's
 *     DOM, ~150× its HTML, until the whole export had converted. `pg_column_size` alone is not a heap bound:
 *     pglz stores realistic pages at ~2.7× and repetitive ones at ~60× smaller (measured, PG 18), so it is only the
 *     cheap first refusal (export-content.ts).
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
}

/** Hard ceilings an env value is clamped to. */
export const EXPORT_LIMIT_CEILINGS = Object.freeze({
  attachmentBytes: 3.5 * GiB - 1,
  maxEntries: 65_000,
  contentBytes: 64 * MiB,
  maxDurationMs: 6 * 60 * 60 * 1000,
  storageTimeoutMs: 5 * 60 * 1000,
});

export const EXPORT_LIMIT_DEFAULTS: Readonly<ExportLimits> = Object.freeze({
  attachmentBytes: 2 * GiB,
  maxEntries: 65_000,
  contentBytes: 16 * MiB,
  maxDurationMs: 30 * 60 * 1000,
  storageTimeoutMs: 10_000,
  existsConcurrency: 8,
});

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
  };
}

const mib = (n: number) => `${Math.ceil(n / MiB).toLocaleString('en-US')} MiB`;

export type ExportTooLargeReason = 'attachments' | 'entries' | 'content' | 'pages';

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
    }
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
