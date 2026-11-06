/**
 * #716 — the native export serializes its pages in the conversion worker, inside a build deadline. Fork-owned.
 *
 * `ExportService.exportPage` (seam §195) turned every page into HTML (`jsonToHtml`, a happy-dom window) and, for
 * Markdown, into Markdown (Turndown on a jsdom window) on the MAIN thread, with no yield between pages: ~0.9 s for the
 * legit 990 KB page and ~2.5 s for a table-heavy one on a laptop (×~2.5 on Graviton), per page, blocking every other
 * request. `renderExportPage` now hands that to the bounded worker (`serializePageContent`): the same composition, the
 * same output. The main thread keeps the JSON walks (mentions → links, internal links, attachment paths) and the
 * structured clone of each page to the worker (~20 ms per 2.7 MB of JSON).
 *
 * `withExportConversion` scopes one export: whose turn and budget its pages take, and how long it may take.
 *   - The human who asked (`userId`, required: an export with no human would take an actorless key, exempt from the
 *     budget and with a turn of its own; it fails closed instead). Their ONE turn (`user:<id>`), so an export never
 *     runs beside that human's own write, but its own budget key (`user:<id>:export`), so exporting never spends the
 *     headroom of that human's writes. A zip takes one batch turn (`batchConversion`): gated once on its first page,
 *     then charged per page, refused 429 once overdrawn (#716 I3), waiting at most the interactive wait for a refill
 *     because an HTTP client is waiting. A single page is interactive: an empty bucket is 429 at once.
 *   - A build deadline (`EXPORT_LIMITS.buildMs`, 45 s; `singlePageBuildMs`, 9 s, for one page) from the START OF THE
 *     EXPORT (`scope.startedAt`, taken at the top of `exportPages`/`exportSpace`, so the subtree read, the PDP filter
 *     and the content load count too), covering every page AND the attachment prechecks in `seal()`: everything
 *     before the first byte, under the platform's time-to-first-byte (50 s; 20 s for one page) and the ALB's 60 s.
 *     Each page's wait is cut to what is left; past it is 503 `export_timeout` (`ExportBuildTimeoutException`).
 *   - A client that disconnects (the request's socket closes) stops the build at the next page or precheck.
 *
 * Refusals, all before the first byte (conversion finishes before the controller sends anything):
 *   - a page past the worker's bounds (deadline, heap, output size) → 422 `export_too_large` reason `page` (a Markdown
 *     export: "export it as HTML, or a smaller page"; HTML: "split it"). Deterministic enough for the same page under
 *     the same load; never retried as is.
 *   - no worker turn in time → 503 `engine_busy`; budget spent → 429 `conversion_budget_exhausted`: passed through.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { CLS_REQ, ClsServiceManager } from 'nestjs-cls';
import { getPageTitle } from '../../common/helpers';
import {
  batchConversion,
  CONTENT_PARSE_LIMITS,
  ContentParseBusyException,
  ContentTooComplexException,
  type ConversionQueue,
  type ParseFormat,
  serializePageContent,
  userConversionKey,
} from '../content-parse/content-parse.service';
import { exportLimits, ExportBuildTimeoutException, ExportTooLargeException } from './export-limits';

const logger = new Logger('Export');

/** 503: the client went away mid-build, so the build stopped. Nobody reads this answer; it ends the work. */
export class ExportCancelledException extends ServiceUnavailableException {
  constructor() {
    super({ message: 'The export was stopped because the request was closed.', code: 'export_cancelled' });
  }
}

interface ExportBuild {
  label: string;
  queue: ConversionQueue;
  deadlineAt: number;
  buildMs: number;
  closed: () => boolean;
  now: () => number;
}

const builds = new AsyncLocalStorage<ExportBuild>();

export interface ExportConversionScope {
  /** Names the export in logs, e.g. `page:<id>` or `space:<id>`. */
  label: string;
  /** The human the export runs for. Required (fails closed). */
  userId: string | null | undefined;
  /** A zip (many pages, one batch turn), or one page (interactive). */
  zip: boolean;
  /** When the export began (ms epoch): the build deadline runs from here. Absent: from this call. */
  startedAt?: number;
}

/** The request socket in scope (nestjs-cls keeps the raw request), for its close. */
function requestSocket(): IncomingMessage['socket'] | undefined {
  try {
    return ClsServiceManager.getClsService()?.get<IncomingMessage | undefined>(CLS_REQ)?.socket ?? undefined;
  } catch {
    return undefined;
  }
}

/** Run one export's build (`fn`: its page serializations and attachment prechecks) under the scope above. */
export async function withExportConversion<T>(
  scope: ExportConversionScope,
  fn: () => Promise<T>,
  options: { buildMs?: number; now?: () => number; socket?: IncomingMessage['socket'] | null } = {},
): Promise<T> {
  if (!scope.userId) {
    // Fail closed: an export no human asked for would convert under an actorless key, outside every budget.
    logger.error(`EXPORT_CONVERSION_NO_ACTOR export=${scope.label}: refused (500)`);
    throw new InternalServerErrorException('The export names no user.');
  }
  const now = options.now ?? Date.now;
  const limits = exportLimits();
  const buildMs = options.buildMs ?? (scope.zip ? limits.buildMs : limits.singlePageBuildMs);
  const startedAt = scope.startedAt ?? now();
  const turnKey = userConversionKey(scope.userId);
  const budgetKey = `${turnKey}:export`;
  const queue: ConversionQueue = scope.zip
    ? { ...batchConversion(`export:${scope.label}`, scope.userId), waitMs: CONTENT_PARSE_LIMITS.waitMs, budgetKey }
    : { principal: turnKey, waitMs: CONTENT_PARSE_LIMITS.waitMs, budgetKey };

  const socket = options.socket === undefined ? requestSocket() : options.socket ?? undefined;
  let closed = Boolean(socket?.destroyed);
  const onClose = () => {
    closed = true;
  };
  socket?.once('close', onClose);
  try {
    return await builds.run(
      { label: scope.label, queue, deadlineAt: startedAt + buildMs, buildMs, closed: () => closed, now },
      fn,
    );
  } finally {
    socket?.off('close', onClose);
  }
}

/** Whether the build in scope may go on: throws past its deadline or once its client has gone. A no-op outside one. */
export function throwIfExportBuildStopped(): void {
  const build = builds.getStore();
  if (!build) return;
  if (build.closed()) {
    // Not EXPORT_ABORTED (alarm-tracked): a user navigating away is routine, not a failure (#716).
    logger.log(`EXPORT_CANCELLED export=${build.label} phase=build: the client closed the request; the build stopped`);
    throw new ExportCancelledException();
  }
  if (build.now() >= build.deadlineAt) {
    logger.warn(`EXPORT_ABORTED reason=build_timeout export=${build.label} buildMs=${build.buildMs}: answered 503 export_timeout`);
    throw new ExportBuildTimeoutException(build.buildMs);
  }
}

/** The ms left before the build in scope must be done; `Infinity` outside one. */
export function exportBuildMsLeft(): number {
  const build = builds.getStore();
  return build ? Math.max(0, build.deadlineAt - build.now()) : Infinity;
}

/**
 * One page as the native export writes it (`ExportService.exportPage`, seam §195): HTML in upstream's document
 * template, or Markdown (upstream's `<colgroup>` strip, then Turndown with its DOM released), serialized in the worker.
 * Any other format is `undefined`, as upstream returned.
 */
export async function renderExportPage(json: unknown, format: string, title: string | null | undefined): Promise<string | undefined> {
  if (format !== 'html' && format !== 'markdown') return undefined;
  const build = builds.getStore();
  if (!build) throw new Error('renderExportPage outside withExportConversion (#716)'); // a programming error: fail closed
  throwIfExportBuildStopped();
  // The same queue object (a batch's budget turn is shared by every page), with the wait cut to the build's time left.
  const queue: ConversionQueue = {
    ...build.queue,
    waitMs: Math.min(build.queue.waitMs ?? CONTENT_PARSE_LIMITS.waitMs, exportBuildMsLeft()),
  };
  let out: string;
  try {
    out = await serializePageContent(json, format as ParseFormat, queue);
  } catch (err) {
    if (err instanceof ContentTooComplexException) {
      logger.warn(`EXPORT_PAGE_TOO_LARGE export=${build.label} format=${format}: answered 422 export_too_large`);
      throw ExportTooLargeException.page(format);
    }
    // A turn missed because the build ran out of time is the build's timeout, not a busy engine.
    if (err instanceof ContentParseBusyException && exportBuildMsLeft() === 0) throwIfExportBuildStopped();
    throw err; // 503 engine_busy, 429 conversion_budget_exhausted, 500: as they are
  }
  if (format === 'html') {
    return `<!DOCTYPE html>
      <html>
        <head>
         <title>${getPageTitle(title)}</title>
        </head>
        <body>${out}</body>
      </html>`;
  }
  return out;
}
