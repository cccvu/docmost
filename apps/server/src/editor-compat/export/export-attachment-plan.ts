/**
 * #699 — the attachments one export writes, decided in full before the first byte is sent. Fork-owned.
 *
 * The upstream `ExportService.zipAttachments` (seam) no longer reads anything: for every attachment a page references
 * that is in the export's already-authorized `allowed` map, it calls `add()`. After the pages are zipped, `seal()`
 * decides the archive, in this order, all before the response starts:
 *   1. budget: Σ `file_size` over the planned entries, counted once per archive path (the same attachment under two
 *      page folders is written, and counted, twice; twice under one folder, once). Only `allowed` attachments ever
 *      reach `add()`, so an attachment of a page the caller cannot view adds nothing: the 422 never tells the caller
 *      anything about content it cannot see. NULL sizes count 0 here; the streamed-bytes backstop catches them.
 *   2. entries: every name the archive will hold (pages, folders JSZip creates for each path, attachments, the
 *      missing-attachments note) against the zip32 limit, computed exactly the way JSZip names them.
 *   3. missing objects: `exists()` for each distinct storage object, 8 at a time. An object storage does not have is
 *      left out of the archive (never an empty entry), logged `EXPORT_ATTACHMENT_MISSING` at WARN, and listed in
 *      `missing-attachments.txt` at the archive root (owner decision, #699). Any OTHER storage error stops the export
 *      with a 503: the archive is never silently incomplete.
 *   4. the remaining attachments are added as lazily opened, STORE'd streams (export-stream.ts). Already-compressed
 *      media gain nothing from DEFLATE, which JSZip runs in pure JS on the main thread.
 */
import { Logger } from '@nestjs/common';
import type * as JSZip from 'jszip';
import type { Readable } from 'node:stream';
import {
  exportLimits,
  ExportLimits,
  ExportStorageException,
  ExportTooLargeException,
  withStorageTimeout,
} from './export-limits';
import { ExportStreamRegistry } from './export-stream';

export const MISSING_ATTACHMENTS_FILE = 'missing-attachments.txt';

export interface PlannedAttachment {
  id: string;
  fileName: string;
  filePath: string;
  /** `attachments.file_size` (int8: the driver returns a string); NULL on some legacy rows. */
  fileSize?: string | number | bigint | null;
}

export interface ExportAttachmentStorage {
  exists(filePath: string): Promise<boolean>;
  readStream(filePath: string): Promise<Readable>;
}

interface PlannedEntry {
  folder: JSZip;
  relPath: string;
  name: string;
  attachment: PlannedAttachment;
  page: { id: string; title: string | null };
}

/** The archive names JSZip creates for `name` (the file, then every parent folder: object.js parentFolder/folderAdd). */
export function zipEntryNames(name: string): string[] {
  const names = [name];
  let path = name;
  for (;;) {
    if (path.endsWith('/')) path = path.slice(0, -1);
    const slash = path.lastIndexOf('/');
    if (slash <= 0) break;
    path = path.slice(0, slash);
    names.push(path.endsWith('/') ? path : `${path}/`);
  }
  return names;
}

/** "No such object" from any driver: S3 GetObject (NoSuchKey), S3 HeadObject (NotFound: a HEAD has no body), local ENOENT. */
export function isMissingObjectError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!e || typeof e !== 'object') return false;
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.code === 'ENOENT' ||
    e.$metadata?.httpStatusCode === 404
  );
}

function declaredSize(a: PlannedAttachment): number {
  if (a.fileSize === null || a.fileSize === undefined) return 0;
  const n = Number(a.fileSize);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A page title on one line of the note: control characters (a newline would forge a line) become spaces. */
const oneLine = (s: string | null | undefined) =>
  [...(s ?? '')].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').trim() || 'untitled';

export class ExportAttachmentPlan {
  private readonly entries = new Map<string, PlannedEntry>();
  private readonly registry: ExportStreamRegistry;
  private sealed = false;

  constructor(
    private readonly storage: ExportAttachmentStorage,
    /** Names the export in logs, e.g. `page:<id>` or `space:<id>`. */
    readonly label: string,
    private readonly limits: ExportLimits = exportLimits(),
    private readonly logger: Pick<Logger, 'warn' | 'error'> = new Logger('Export'),
  ) {
    this.registry = new ExportStreamRegistry(label, limits, logger);
  }

  /** Record one authorized attachment a page references, at `relPath` inside `folder`. Reads nothing. */
  add(folder: JSZip, relPath: string, attachment: PlannedAttachment, page: { id: string; title: string | null }): void {
    if (this.sealed) throw new Error('ExportAttachmentPlan.add after seal');
    const name = `${(folder as unknown as { root?: string }).root ?? ''}${relPath}`;
    if (this.entries.has(name)) return;
    this.entries.set(name, { folder, relPath, name, attachment, page });
  }

  /** Σ declared bytes of the planned entries (for tests and diagnostics). */
  get declaredBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += declaredSize(e.attachment);
    return total;
  }

  /** Steps 1–4 above. Throws 422 / 503 before any byte; on a throw the plan holds nothing open. */
  async seal(zip: JSZip): Promise<void> {
    if (this.sealed) throw new Error('ExportAttachmentPlan.seal twice');
    this.sealed = true;
    try {
      await this.decide(zip);
    } catch (err) {
      this.registry.dispose();
      throw err;
    }
  }

  /** Hand JSZip's output over; returns the stream to send. Arms the wall-clock cap and the cleanup. */
  stream(zipOut: NodeJS.ReadableStream): Readable {
    return this.registry.attach(zipOut);
  }

  private async decide(zip: JSZip): Promise<void> {
    const declared = this.declaredBytes;
    if (declared > this.limits.attachmentBytes) {
      throw new ExportTooLargeException('attachments', declared, this.limits.attachmentBytes);
    }

    // Upper bound before any storage call (every planned entry present, plus the note): refuse a too-big archive
    // without HEADing tens of thousands of objects. Exact recount after the adds below.
    const names = new Set(Object.keys(zip.files));
    for (const e of this.entries.values()) for (const n of zipEntryNames(e.name)) names.add(n);
    if (this.entries.size > 0) names.add(MISSING_ATTACHMENTS_FILE);
    if (names.size > this.limits.maxEntries) {
      throw new ExportTooLargeException('entries', names.size, this.limits.maxEntries);
    }

    const present = await this.existing([...new Set([...this.entries.values()].map((e) => e.attachment.filePath))]);
    this.registry.throwIfFailed();

    const missing: PlannedEntry[] = [];
    for (const e of this.entries.values()) {
      if (!present.has(e.attachment.filePath)) {
        missing.push(e);
        continue;
      }
      const filePath = e.attachment.filePath;
      e.folder.file(
        e.relPath,
        this.registry.lazy(e.attachment.id, () => this.storage.readStream(filePath)),
        { binary: true, compression: 'STORE' },
      );
    }

    if (missing.length > 0) {
      for (const e of missing) {
        this.logger.warn(
          `EXPORT_ATTACHMENT_MISSING export=${this.label} page=${e.page.id} attachment=${e.attachment.id}: ` +
            'not in storage; left out of the archive and listed in ' + MISSING_ATTACHMENTS_FILE,
        );
      }
      zip.file(
        MISSING_ATTACHMENTS_FILE,
        [
          'These attachments are referenced by the exported pages but were not found in storage,',
          'so they are not in this archive. Each line: the path it would have had, then the page that references it.',
          '',
          ...missing.map((e) => `${e.name}\t${oneLine(e.page.title)}`),
          '',
        ].join('\n'),
      );
    }

    const count = Object.keys(zip.files).length;
    if (count > this.limits.maxEntries) {
      throw new ExportTooLargeException('entries', count, this.limits.maxEntries);
    }
  }

  /** The storage paths that exist; throws 503 on any storage error other than "no such object". */
  private async existing(paths: string[]): Promise<Set<string>> {
    const present = new Set<string>();
    let next = 0;
    let failed: unknown = null;
    const worker = async () => {
      while (failed === null && next < paths.length) {
        const p = paths[next++];
        try {
          if (await withStorageTimeout(this.storage.exists(p), this.limits.storageTimeoutMs, 'exists()')) present.add(p);
        } catch (err) {
          if (isMissingObjectError(err)) continue;
          if (failed === null) failed = err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.existsConcurrency, paths.length) }, worker));
    if (failed !== null) {
      this.logger.error(
        `EXPORT_ABORTED reason=storage_error export=${this.label} phase=precheck: ${
          failed instanceof Error ? failed.message : String(failed)
        }`,
      );
      throw new ExportStorageException();
    }
    return present;
  }
}
