import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceResolver } from './workspace-resolver';
import { asEngineBusy, engineBusy } from './resource-version';
import { OpSemaphore, OpSemaphoreTimeout } from '../authz/page-write/op-semaphore';
import {
  PAGE_IMPORT_ITEM_MAX_BYTES,
  PAGE_IMPORT_TOTAL_MAX_BYTES,
  PageImportFormat,
  TitleCandidatesDto,
  ValidateContentDto,
} from './dto/page-import.dto';

/**
 * Why an item's content was refused. `invalid_content`, `too_large` and `empty_content` are properties of the content
 * (or of the request's total size), so the same request fails again; `parse_budget_exceeded` is NOT: the call's parse
 * time ran out before this item was parsed, so it was not checked at all and the same request can pass on a retry.
 */
export type ContentValidationCode = 'invalid_content' | 'too_large' | 'empty_content' | 'parse_budget_exceeded';
export type ContentValidationResult = { idx: number; ok: true } | { idx: number; ok: false; code: ContentValidationCode };
export interface ValidateContentResult {
  results: ContentValidationResult[];
}

export interface TitleCandidate {
  titleIdx: number;
  pageId: string;
  /** null: the title is exactly `titles[titleIdx]`; n (≥ 2): it is `${titles[titleIdx]} (${n})`. */
  suffix: number | null;
}
export interface TitleCandidatesResult {
  matches: TitleCandidate[];
}

/** Wall-clock budget for the parses of ONE validate-content call; past it, the remaining items are `parse_budget_exceeded`. */
export const PAGE_IMPORT_PARSE_BUDGET_MS = 4000;
/** validate-content calls parsing at once per process, and how long a call waits for a slot (then 503 engine_busy). */
export const PAGE_IMPORT_PARSE_MAX_CONCURRENT = 2;
export const PAGE_IMPORT_PARSE_SLOT_WAIT_MS = 2000;
/** Live children title-candidates reads for one parent; more → 503 `list_too_broad`. */
export const TITLE_CANDIDATES_MAX_SCAN = 5000;
export const TITLE_CANDIDATES_STATEMENT_TIMEOUT = '5s';

/** `<prefix> (<n>)`: n a canonical positive integer (no leading zero), at most 9 digits. */
const SUFFIXED = /^([\s\S]*) \(([1-9][0-9]{0,8})\)$/;

/** The 503 for a parent with more live children than the scan bound. */
export function listTooBroad(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: `the parent has more than ${TITLE_CANDIDATES_MAX_SCAN} live child pages; titles cannot be compared`,
    code: 'list_too_broad',
  });
}

/**
 * Parses content through `PageService.parseProsemirrorContent` — the exact path a page create takes (Markdown →
 * HTML → the #621 network-inert happy-dom parse → ProseMirror JSON → schema check). Resolved lazily from the app's
 * container: page.service.ts pulls in the collaboration graph, which must stay out of the service bridge's import
 * chain (the bridge is reachable from DatabaseModule); by the first request the app's PageModule is initialized.
 */
@Injectable()
export class PageContentParser {
  constructor(private readonly moduleRef: ModuleRef) {}

  async parse(content: string, format: PageImportFormat): Promise<unknown> {
    const { PageService } = await import('../core/page/services/page.service');
    return this.moduleRef.get(PageService, { strict: false }).parseProsemirrorContent(content, format);
  }
}

/**
 * CCC service-bridge — NOT upstream Docmost code (#616).
 *
 * The two read-only helpers the platform's page import plans with. Neither writes anything, and neither ever answers
 * content or a title — only indices, ids and codes.
 *
 * validate-content: each item is parsed exactly as a create would parse it, SEQUENTIALLY (the event loop is yielded
 * between items), inside two budgets — ≤ PAGE_IMPORT_TOTAL_MAX_BYTES of parsed content and ≤ PAGE_IMPORT_PARSE_BUDGET_MS
 * of parsing; at the first overrun that item and every later one answer unparsed: `too_large` for the byte budget (a
 * property of the request), `parse_budget_exceeded` for the time budget (the engine's load, not the content: the item
 * was never checked, and the caller must retry, never "fix" it). An item over
 * PAGE_IMPORT_ITEM_MAX_BYTES is `too_large` on its own; whitespace-only content is `empty_content`; a parse failure is
 * `invalid_content` (its message is never answered: it can quote the content). At most
 * PAGE_IMPORT_PARSE_MAX_CONCURRENT calls parse at once per process; a call that gets no slot in time is 503 `engine_busy`.
 *
 * title-candidates: the LIVE direct children of one parent (or of the space root) whose title is exactly an input title
 * or `<title> (n)` with n ≥ 2, as `{titleIdx, pageId, suffix}`. Case-sensitive and untrimmed, compared in memory (no
 * LIKE pattern to escape). A title repeated in the input is answered under its FIRST index. At most
 * TITLE_CANDIDATES_MAX_SCAN children are read; a parent with more is 503 `list_too_broad`. The platform keeps only the
 * matches the caller may `page#view`, so a page it cannot see never shapes an import.
 */
@Injectable()
export class ServicePageImportService {
  private readonly logger = new Logger(ServicePageImportService.name);
  private readonly parseSlots = new OpSemaphore(PAGE_IMPORT_PARSE_MAX_CONCURRENT, PAGE_IMPORT_PARSE_SLOT_WAIT_MS);
  /** Overridable in tests. */
  parseBudgetMs = PAGE_IMPORT_PARSE_BUDGET_MS;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
    private readonly parser: PageContentParser,
  ) {}

  async validateContent(dto: ValidateContentDto): Promise<ValidateContentResult> {
    try {
      return await this.parseSlots.run(() => this.validateAll(dto));
    } catch (err) {
      if (err instanceof OpSemaphoreTimeout) {
        this.logger.warn('PAGE_IMPORT_VALIDATE_BUSY: no parse slot in time; answered 503 engine_busy');
        throw engineBusy();
      }
      throw err;
    }
  }

  private async validateAll(dto: ValidateContentDto): Promise<ValidateContentResult> {
    const started = Date.now();
    let parsedBytes = 0;
    /** Set at the first overrun: the code that item and every later one answer, unparsed. */
    let stopped: 'too_large' | 'parse_budget_exceeded' | null = null;
    const results: ContentValidationResult[] = [];
    for (let idx = 0; idx < dto.items.length; idx++) {
      const { format, content } = dto.items[idx];
      if (stopped) {
        results.push({ idx, ok: false, code: stopped });
        continue;
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > PAGE_IMPORT_ITEM_MAX_BYTES) {
        results.push({ idx, ok: false, code: 'too_large' });
        continue;
      }
      if (content.trim() === '') {
        results.push({ idx, ok: false, code: 'empty_content' });
        continue;
      }
      if (parsedBytes + bytes > PAGE_IMPORT_TOTAL_MAX_BYTES) {
        stopped = 'too_large';
      } else if (Date.now() - started > this.parseBudgetMs) {
        stopped = 'parse_budget_exceeded';
      }
      if (stopped) {
        this.logger.warn(
          `PAGE_IMPORT_VALIDATE_BUDGET idx=${idx} budget=${stopped === 'too_large' ? 'bytes' : 'time'}: ` +
            `budget spent; this and later items answered ${stopped}`,
        );
        results.push({ idx, ok: false, code: stopped });
        continue;
      }
      parsedBytes += bytes;
      try {
        await this.parser.parse(content, format);
        results.push({ idx, ok: true });
      } catch {
        results.push({ idx, ok: false, code: 'invalid_content' });
      }
      if (idx < dto.items.length - 1) await new Promise<void>((r) => setImmediate(r));
    }
    return { results };
  }

  async titleCandidates(dto: TitleCandidatesDto): Promise<TitleCandidatesResult> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const parent = dto.parentPageId ?? null;
    let rows: Array<{ id: string; title: string | null }>;
    try {
      rows = await this.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = ${sql.lit(TITLE_CANDIDATES_STATEMENT_TIMEOUT)}`.execute(trx);
        const res = await sql<{ id: string; title: string | null }>`
          select id, title from pages
          where workspace_id = ${workspaceId} and space_id = ${dto.spaceId} and deleted_at is null
            and ${parent === null ? sql`parent_page_id is null` : sql`parent_page_id = ${parent}`}
          limit ${sql.lit(TITLE_CANDIDATES_MAX_SCAN + 1)}
        `.execute(trx);
        return res.rows;
      });
    } catch (err) {
      const busy = asEngineBusy(err);
      if (busy) throw busy;
      throw err;
    }
    if (rows.length > TITLE_CANDIDATES_MAX_SCAN) throw listTooBroad();

    const firstIdx = new Map<string, number>();
    dto.titles.forEach((t, i) => {
      if (!firstIdx.has(t)) firstIdx.set(t, i);
    });
    const matches: TitleCandidate[] = [];
    for (const row of rows) {
      if (typeof row.title !== 'string') continue;
      const exact = firstIdx.get(row.title);
      if (exact !== undefined) matches.push({ titleIdx: exact, pageId: row.id, suffix: null });
      const m = SUFFIXED.exec(row.title);
      if (m) {
        const n = Number(m[2]);
        const base = firstIdx.get(m[1]);
        if (base !== undefined && n >= 2) matches.push({ titleIdx: base, pageId: row.id, suffix: n });
      }
    }
    matches.sort(
      (a, b) =>
        a.titleIdx - b.titleIdx ||
        (a.suffix ?? 0) - (b.suffix ?? 0) ||
        (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0),
    );
    return { matches };
  }
}
