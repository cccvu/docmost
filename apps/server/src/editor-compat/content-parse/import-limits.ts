/**
 * #643 — what one imported page file may cost the engine's main thread.
 *
 * Fork-owned. The conversion itself runs in the bounded worker (`content-parse.service.ts`, #626), but each importer
 * still runs cheerio passes over the page's HTML on the MAIN thread first: one for a single-file import
 * (`ImportService.processHTML`), three for a zip page (attachments, formatting, `processHTML`). Their cost grows with
 * the markup, and the main heap is capped at 1 GiB with one engine task (ADR 0031), so an unbounded page file was an
 * engine restart — a full outage — that any space editor could cause.
 *
 * Bounds, each measured on a dev laptop with `--max-old-space-size=1024` (production Graviton is ~2–2.5× slower):
 *   - `maxPageFileBytes` 4 MiB per .md/.html file, checked on the raw bytes before they are decoded: the single-file
 *     upload's buffer, and every zip page file's `stat` before the import starts. Real content (this repo's docs)
 *     converts up to ~2–2.5 MiB; past that the worker refuses it on its node cap anyway. One cheerio pass over 4 MiB
 *     of that content takes ~0.5 s and ~175 MB of heap.
 *   - `maxMarkdownHtmlChars` = 2 × the file cap, the most HTML one imported Markdown file may become (the worker
 *     refuses more as 422 `content_too_complex`, before any cheerio pass). Real Markdown grows ~1.2× (4 MiB →
 *     5.0 Mi characters), so a file under the cap is never refused for its own expansion; `a\n\n` grows 3×.
 *   - `maxHtmlTags` 200,000 `<` in any HTML an importer is about to load into cheerio. Bytes alone do not bound the
 *     DOM: 4 MiB of `<p>a</p>` is 600 MB of heap and 1.4 s, and 8 Mi characters of it (what 2.7 MiB of `a\n\n` becomes)
 *     exhausted a fresh 1 GiB heap. The DOM grows with the number of tags (~620 bytes each when dense), so this caps a
 *     pass at ~130 MB / ~0.35 s for the densest markup; real content has ~35k tags per MiB of HTML, and the largest
 *     page that converts (~2.5 MiB of Markdown) ~110k. Past it is 422 `content_too_complex`, like the worker's caps.
 *
 * Every refusal names the limit, and none carries a server path: a zip import's message is stored on its file task and
 * shown to the user, so only paths relative to the archive appear in it (`importTaskError`).
 */
import { HttpException, type Logger, PayloadTooLargeException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ContentTooComplexException } from './content-parse.service';

export interface ImportLimits {
  /** The single-file import's upload limit: `import.controller.ts` passes `bytes('30mb')` to `req.file()` (pinned). */
  singleFileBytes: number;
  /** The most bytes one .md/.html page file may have, single-file or in a zip. */
  maxPageFileBytes: number;
  /** The most characters of HTML one imported Markdown file may become. */
  maxMarkdownHtmlChars: number;
  /** The most tags (`<`) in HTML that an importer loads into cheerio. */
  maxHtmlTags: number;
}

const MAX_PAGE_FILE_BYTES = 4 * 1024 * 1024;

export const IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  singleFileBytes: 30 * 1024 * 1024,
  maxPageFileBytes: MAX_PAGE_FILE_BYTES,
  maxMarkdownHtmlChars: 2 * MAX_PAGE_FILE_BYTES,
  maxHtmlTags: 200_000,
});

/** The page formats whose bytes become HTML on the main thread. */
export function isImportPageFile(fileNameOrExt: string): boolean {
  const ext = (path.extname(fileNameOrExt) || fileNameOrExt).toLowerCase();
  return ext === '.md' || ext === '.html';
}

/**
 * A size as people read it: "30 MB", "12.3 MB", "512 KB" (1024-based, as the engine's size settings are). `up` rounds
 * up, so a file just over a limit never reads as the limit itself ("4.1 MB", not "4 MB").
 */
export function formatImportSize(bytes: number, up = false): string {
  const [unit, size] = bytes >= 1024 * 1024 ? ['MB', 1024 * 1024] : bytes >= 1024 ? ['KB', 1024] : ['bytes', 1];
  const tenths = (up ? Math.ceil : Math.round)((bytes / size) * 10) / 10;
  return `${tenths.toFixed(1).replace(/\.0$/, '')} ${unit}`;
}

/** A user-supplied name (a file name, a path inside an archive) made safe to echo in a message. */
function shown(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(name).replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > 120 ? `…${clean.slice(-119)}` : clean;
}

function pageFileTooLargeText(name: string, bytes: number): string {
  return `'${shown(name)}' is ${formatImportSize(bytes, true)}`;
}

const PAGE_FILE_LIMIT_TEXT = (): string =>
  `each page file in an import is limited to ${formatImportSize(IMPORT_LIMITS.maxPageFileBytes)}`;

/**
 * The single-file upload's bytes. Fastify's multipart answers an over-limit file with its own 413 ("request file too
 * large", no limit stated) from `toBuffer()` — or, when the limit is hit on the last chunk, returns the TRUNCATED
 * buffer with `file.truncated` set and no error at all (measured: about 1 in 5 uploads just over the limit). Both
 * become one 413 that names the limit; a truncated file is never imported.
 */
export async function readImportUpload(file: {
  toBuffer(): Promise<Buffer>;
  file?: { truncated?: boolean };
}): Promise<Buffer> {
  const tooLarge = () =>
    new PayloadTooLargeException(
      `File too large. The import limit is ${formatImportSize(IMPORT_LIMITS.singleFileBytes)}`,
    );
  let buffer: Buffer;
  try {
    buffer = await file.toBuffer();
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    if (err instanceof PayloadTooLargeException || e?.statusCode === 413 || e?.code === 'FST_REQ_FILE_TOO_LARGE') {
      throw tooLarge();
    }
    throw err;
  }
  if (file.file?.truncated) throw tooLarge();
  return buffer;
}

/** 413 unless a .md/.html page file of `bytes` is within the per-file cap. Call it before decoding the bytes. */
export function assertImportPageFileSize(bytes: number, name: string): void {
  if (bytes > IMPORT_LIMITS.maxPageFileBytes) {
    throw new PayloadTooLargeException(`File too large. ${pageFileTooLargeText(name, bytes)}; ${PAGE_FILE_LIMIT_TEXT()}`);
  }
}

/**
 * 422 `content_too_complex` unless `html` is within the tag bound. Call it on HTML an importer is about to load into
 * cheerio; it is one linear scan (~1.5 ms per MiB) and never parses.
 */
export function assertImportHtmlWithinBounds(html: string, logger?: Pick<Logger, 'warn'>): void {
  let tags = 0;
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i + 1)) {
    if (++tags > IMPORT_LIMITS.maxHtmlTags) {
      logger?.warn(
        `IMPORT_TOO_COMPLEX reason=tags chars=${html.length}: more than ${IMPORT_LIMITS.maxHtmlTags} tags; answered 422 content_too_complex`,
      );
      throw new ContentTooComplexException();
    }
  }
}

/** A zip-relative path, POSIX-separated: the only form of a page's location that a message may carry. */
export function importRelativePath(extractDir: string, absPath: string): string {
  return path.relative(extractDir, absPath).split(path.sep).join('/');
}

/**
 * The zip pre-flight: before the import's transaction and before any attachment is uploaded, refuse the whole import
 * if any page file is over the per-file cap, naming up to three of them by their path in the archive.
 */
export async function assertZipPageFilesWithinCap(extractDir: string, pageFiles: readonly string[]): Promise<void> {
  const over: Array<{ rel: string; size: number }> = [];
  for (const absPath of pageFiles) {
    let size: number;
    try {
      ({ size } = await fs.stat(absPath));
    } catch (err) {
      throw new ImportFileError(importRelativePath(extractDir, absPath), err);
    }
    if (size > IMPORT_LIMITS.maxPageFileBytes) over.push({ rel: importRelativePath(extractDir, absPath), size });
  }
  if (over.length === 0) return;
  const named = over.slice(0, 3).map((f) => pageFileTooLargeText(f.rel, f.size));
  const more = over.length > 3 ? `, and ${over.length - 3} more` : '';
  throw new PayloadTooLargeException(`${named.join(', ')}${more}; ${PAGE_FILE_LIMIT_TEXT()}`);
}

/** A failure we have already worded for the user. Its message is shown as is. */
export class ImportTaskFailure extends Error {}

/** A non-HTTP error while handling one page file; `importTaskError` words it with the file's archive path. */
export class ImportFileError extends Error {
  constructor(
    readonly relPath: string,
    readonly cause: unknown,
  ) {
    super('import file error');
  }
}

/** Upstream `extractZip`'s own refusals: worded for the user, and path-free. */
const AUTHORED_ARCHIVE_ERRORS = new Set([
  'Import archive exceeds the allowed extracted size limit',
  'Import archive has too many entries',
]);

const TRANSIENT_CODES = new Set(['EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOSPC', 'EIO', 'EBUSY']);

/** A short reason for an error we did not word, from its code only — never its message, which may carry a path. */
function shortReason(err: unknown, file: string | null): string {
  const code = String((err as { code?: unknown })?.code ?? '');
  if (TRANSIENT_CODES.has(code)) return `${file ? 'it' : 'the archive'} could not be read; try again later`;
  if (!file) return 'the archive could not be processed';
  switch (code) {
    case 'ENOENT':
      return 'it is missing from the archive';
    case 'ENAMETOOLONG':
      return 'its path is too long';
    case 'EISDIR':
    case 'ENOTDIR':
      return 'it is not a file';
    case 'ERR_STRING_TOO_LONG':
      return 'it is too large';
    default:
      return 'it could not be imported';
  }
}

/**
 * The error a zip import task fails with. Its message becomes the task's stored `errorMessage`, which the SPA shows,
 * so it is always one we wrote: our HTTP refusals (413/422/503/400) as they are, prefixed with the page's archive path
 * when known; `extractZip`'s own refusals; and for anything else (fs, database, parser errors, whose messages can
 * carry the server's extract path or content) "Import failed: <path>: <reason>", with the raw error logged here only.
 */
export function importTaskError(err: unknown, ctx: { file?: string | null; logger: Pick<Logger, 'error'> }): Error {
  if (err instanceof ImportTaskFailure) return err;
  let file = ctx.file ?? null;
  let cause = err;
  if (err instanceof ImportFileError) {
    file = err.relPath;
    cause = err.cause;
  }
  const where = file ? `${shown(file)}: ` : '';
  if (cause instanceof HttpException) {
    return new ImportTaskFailure(`Import failed: ${where}${httpMessage(cause)}`);
  }
  if (cause instanceof Error && AUTHORED_ARCHIVE_ERRORS.has(cause.message)) {
    return new ImportTaskFailure(`Import failed: ${cause.message}`);
  }
  ctx.logger.error(`IMPORT_TASK_FAILED${file ? ` file=${JSON.stringify(shown(file))}` : ''}`, cause);
  return new ImportTaskFailure(`Import failed: ${where}${shortReason(cause, file)}`);
}

function httpMessage(err: HttpException): string {
  const body = err.getResponse() as string | { message?: unknown };
  const message = typeof body === 'string' ? body : body?.message;
  return Array.isArray(message) ? message.join('; ') : String(message ?? err.message);
}
