import { HttpException } from '@nestjs/common';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

// The REAL parse path (PageService.parseProsemirrorContent) is exercised below; its module graph pulls in the collab
// WebSocket stack (lib0 ESM) that jest cannot parse, and parsing never touches it. Stub it.
jest.mock('../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import {
  PageContentParser,
  ServicePageImportService,
  TITLE_CANDIDATES_MAX_SCAN,
} from './service-page-import.service';
import { PAGE_IMPORT_ITEM_MAX_BYTES, PageImportFormat } from './dto/page-import.dto';
import { PageService } from '../core/page/services/page.service';
import { OpSemaphore } from '../authz/page-write/op-semaphore';

/**
 * #616 page-import helpers — the unit contract (real Postgres for title-candidates: service-page-import.pg.spec.ts):
 *   validate-content: every item parsed through the create's own parser, sequentially; per-item `too_large` /
 *   `empty_content` / `invalid_content`; the call's byte and time budgets stop at the first overrun (that item and all
 *   later ones `too_large`, unparsed); at most 2 calls parse at once (else 503 engine_busy); content and parse errors
 *   are never answered.
 *   title-candidates: exact and `(n ≥ 2)` matches only, ids + indices only, bounded scan (503 list_too_broad), a
 *   statement past its bound → 503 engine_busy.
 */
const WS = 'ws-1';
const workspaces = { resolveDefaultWorkspaceId: async () => WS } as never;

/** The real PageContentParser over the app's PageService (the method uses no instance state). */
const realParser = () => new PageContentParser({ get: () => PageService.prototype } as never);

const make = (parse?: (content: string, format: PageImportFormat) => Promise<unknown>, respond: (q: SpyQuery) => unknown[] = () => []) => {
  const spy = spyKysely(respond);
  const parsed: string[] = [];
  const parser = {
    parse: jest.fn(async (content: string, format: PageImportFormat) => {
      parsed.push(content);
      return parse ? parse(content, format) : {};
    }),
  };
  return { svc: new ServicePageImportService(spy.db, workspaces, parser as never), spy, parser, parsed };
};
const status = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected a rejection');
};

describe('validate-content through the REAL create parser (#621 network-inert window)', () => {
  const svc = new ServicePageImportService(spyKysely(() => []).db, workspaces, realParser());

  it('accepts valid markdown and html; rejects empty; answers ids and codes only (never content or an error)', async () => {
    const res = await svc.validateContent({
      items: [
        { format: 'markdown', content: '# Title\n\nSome *text* and a [link](https://example.com).' },
        { format: 'html', content: '<h2>Hi</h2><p>there <iframe src="http://127.0.0.1:1/x"></iframe></p>' },
        { format: 'html', content: '   \n\t ' },
        { format: 'markdown', content: '' },
      ],
    });
    expect(res).toEqual({
      results: [
        { idx: 0, ok: true },
        { idx: 1, ok: true },
        { idx: 2, ok: false, code: 'empty_content' },
        { idx: 3, ok: false, code: 'empty_content' },
      ],
    });
  });

  it('a body the create path refuses is invalid_content — and the refusal text is not answered', async () => {
    const svcWith = make(async (content, format) => PageService.prototype.parseProsemirrorContent(content, format));
    const res = await svcWith.svc.validateContent({ items: [{ format: 'html', content: '<p>ok</p>' }, { format: 'json' as never, content: 'not a doc' }] });
    expect(res).toEqual({ results: [{ idx: 0, ok: true }, { idx: 1, ok: false, code: 'invalid_content' }] });
    expect(JSON.stringify(res)).not.toContain('not a doc');
  });
});

describe('validate-content — budgets and codes', () => {
  it('an item over 512 KiB (UTF-8 bytes, not chars) is too_large on its own; later items still parse', async () => {
    const multiByte = 'é'.repeat(PAGE_IMPORT_ITEM_MAX_BYTES / 2 + 1); // chars < limit, bytes > limit
    const t = make();
    const res = await t.svc.validateContent({
      items: [
        { format: 'markdown', content: multiByte },
        { format: 'markdown', content: 'x'.repeat(PAGE_IMPORT_ITEM_MAX_BYTES) }, // exactly at the limit: parsed
        { format: 'html', content: '<p>fine</p>' },
      ],
    });
    expect(res.results).toEqual([
      { idx: 0, ok: false, code: 'too_large' },
      { idx: 1, ok: true },
      { idx: 2, ok: true },
    ]);
    expect(t.parsed).toHaveLength(2);
  });

  it('the 1 MiB call budget stops at the first overrun: that item and EVERY later one are too_large, unparsed', async () => {
    const half = 'x'.repeat(PAGE_IMPORT_ITEM_MAX_BYTES); // 512 KiB each: two fit exactly, the third overruns
    const t = make();
    const res = await t.svc.validateContent({
      items: [
        { format: 'markdown', content: half },
        { format: 'markdown', content: half },
        { format: 'markdown', content: 'tiny' }, // would fit alone — but the budget is spent
        { format: 'markdown', content: 'tiny' },
      ],
    });
    expect(res.results).toEqual([
      { idx: 0, ok: true },
      { idx: 1, ok: true },
      { idx: 2, ok: false, code: 'too_large' },
      { idx: 3, ok: false, code: 'too_large' },
    ]);
    expect(t.parsed).toHaveLength(2);
  });

  it('the time budget stops at the first overrun too (checked before each item)', async () => {
    let clock = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const t = make(async () => {
        clock += 3000; // each parse "takes" 3s
      });
      t.svc.parseBudgetMs = 4000;
      const res = await t.svc.validateContent({ items: ['a', 'b', 'c', 'd'].map((content) => ({ format: 'markdown' as const, content })) });
      // 0s → parse a (3s) → parse b (6s) → 6s > 4s: c and d are too_large.
      expect(res.results).toEqual([
        { idx: 0, ok: true },
        { idx: 1, ok: true },
        { idx: 2, ok: false, code: 'too_large' },
        { idx: 3, ok: false, code: 'too_large' },
      ]);
      expect(t.parsed).toEqual(['a', 'b']);
    } finally {
      now.mockRestore();
    }
  });

  it('parses sequentially, in item order, yielding between items', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const t = make(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    await t.svc.validateContent({ items: ['1', '2', '3'].map((content) => ({ format: 'html' as const, content })) });
    expect(maxInFlight).toBe(1);
    expect(t.parsed).toEqual(['1', '2', '3']);
  });

  it('at most 2 calls parse at once per process; a third that finds no slot in time is 503 engine_busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = make(() => gate);
    (t.svc as unknown as { parseSlots: OpSemaphore }).parseSlots = new OpSemaphore(2, 20);
    const one = t.svc.validateContent({ items: [{ format: 'html', content: 'a' }] });
    const two = t.svc.validateContent({ items: [{ format: 'html', content: 'b' }] });
    const three = await status(t.svc.validateContent({ items: [{ format: 'html', content: 'c' }] }));
    expect(three).toEqual({ status: 503, body: { message: expect.any(String), code: 'engine_busy' } });
    release();
    await expect(Promise.all([one, two])).resolves.toHaveLength(2);
  });
});

describe('title-candidates', () => {
  const PARENT = '00000000-0000-4000-8000-000000000001';
  const SPACE = '00000000-0000-4000-8000-000000000050';
  const rows = (titles: Array<string | null>) => titles.map((title, i) => ({ id: `p-${String(i).padStart(2, '0')}`, title }));

  it('reads the live children of the parent, workspace- and space-scoped, bounded, under a statement timeout', async () => {
    const t = make(undefined, () => []);
    await t.svc.titleCandidates({ spaceId: SPACE, parentPageId: PARENT, titles: ['A'] });
    const sqls = t.spy.calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toBe("SET LOCAL statement_timeout = '5s'");
    expect(sqls[1]).toBe(
      'select id, title from pages where workspace_id = $1 and space_id = $2 and deleted_at is null and parent_page_id = $3 ' +
        `limit ${TITLE_CANDIDATES_MAX_SCAN + 1}`,
    );
    expect(t.spy.calls[1].parameters).toEqual([WS, SPACE, PARENT]);
    expect(t.spy.tx).toEqual(['begin', 'commit']);
  });

  it('the root level (parentPageId omitted or null) reads parent_page_id IS NULL', async () => {
    for (const parentPageId of [undefined, null]) {
      const t = make(undefined, () => []);
      await t.svc.titleCandidates({ spaceId: SPACE, parentPageId, titles: ['A'] });
      expect(t.spy.calls[1].sql).toMatch(/parent_page_id is null/);
      expect(t.spy.calls[1].parameters).toEqual([WS, SPACE]);
    }
  });

  it('matches the exact title and `<title> (n)` for n ≥ 2 only; ids + indices, never a title; sorted', async () => {
    const t = make(undefined, (q) =>
      /select id, title/.test(q.sql)
        ? rows([
            'Notes', // 0 exact
            'Notes (2)', // 1 suffix 2
            'Notes (10)', // 2 suffix 10
            'Notes (1)', // 3 n < 2: no
            'Notes (02)', // 4 leading zero: no
            'notes', // 5 case differs: no
            'Notes ', // 6 trailing space: no
            'Notes(3)', // 7 no space: no
            'Plan (2) (3)', // 8 → "Plan (2)" suffix 3 (and not "Plan")
            'Plan (2)', // 9 exact for "Plan (2)", suffix 2 for "Plan"
            null, // 10 untitled
            'Other', // 11
          ])
        : [],
    );
    const res = await t.svc.titleCandidates({ spaceId: SPACE, titles: ['Plan', 'Notes', 'Plan (2)', 'Notes'] });
    expect(res).toEqual({
      matches: [
        { titleIdx: 0, pageId: 'p-09', suffix: 2 },
        { titleIdx: 1, pageId: 'p-00', suffix: null },
        { titleIdx: 1, pageId: 'p-01', suffix: 2 },
        { titleIdx: 1, pageId: 'p-02', suffix: 10 },
        { titleIdx: 2, pageId: 'p-09', suffix: null },
        { titleIdx: 2, pageId: 'p-08', suffix: 3 },
      ],
    });
    // A repeated input title (idx 3) is answered under its first index only; no title text anywhere.
    expect(res.matches.some((m) => m.titleIdx === 3)).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/Notes|Plan/);
  });

  it('LIKE metacharacters are plain text (compared in memory)', async () => {
    const t = make(undefined, (q) => (/select id, title/.test(q.sql) ? rows(['100%', '100% (2)', '1000', 'a_b', 'axb']) : []));
    const res = await t.svc.titleCandidates({ spaceId: SPACE, titles: ['100%', 'a_b'] });
    expect(res.matches).toEqual([
      { titleIdx: 0, pageId: 'p-00', suffix: null },
      { titleIdx: 0, pageId: 'p-01', suffix: 2 },
      { titleIdx: 1, pageId: 'p-03', suffix: null },
    ]);
  });

  it('more than 5000 live children → 503 list_too_broad', async () => {
    const t = make(undefined, (q) =>
      /select id, title/.test(q.sql) ? Array.from({ length: TITLE_CANDIDATES_MAX_SCAN + 1 }, (_, i) => ({ id: `p${i}`, title: 'x' })) : [],
    );
    expect(await status(t.svc.titleCandidates({ spaceId: SPACE, titles: ['x'] }))).toEqual({
      status: 503,
      body: { message: expect.any(String), code: 'list_too_broad' },
    });
  });

  it('a read past its statement bound (57014) → 503 engine_busy', async () => {
    const t = make(undefined, (q) => {
      if (/select id, title/.test(q.sql)) throw Object.assign(new Error('canceled'), { code: '57014' });
      return [];
    });
    expect((await status(t.svc.titleCandidates({ spaceId: SPACE, titles: ['x'] }))).body).toMatchObject({ code: 'engine_busy' });
  });
});
