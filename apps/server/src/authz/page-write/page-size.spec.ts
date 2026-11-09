// The seam case below loads PageService's module graph, which pulls the collab WebSocket stack (lib0 ESM) jest cannot
// parse; the method under test never touches it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { HttpException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import {
  accumulates,
  applyWithinPageCap,
  assertPageCanGrow,
  growthLockCount,
  isOverPageCap,
  PAGE_MAX_YDOC_BYTES,
  pageMaxYdocBytesFromEnv,
  PageTooLargeException,
  storedYdocBytes,
  withPageGrowthLock,
} from './page-size';
import { PageService } from '../../core/page/services/page.service';

const MiB = 1024 * 1024;

/** A Kysely-shaped fake for the one size query; `sql` records the compiled select so a spec can pin it. */
const fakeDb = (result: { bytes: unknown } | undefined | Error) => {
  const seen = { selects: [] as string[], tables: [] as string[], runs: 0 };
  const db = {
    selectFrom: (t: string) => {
      seen.tables.push(t);
      const q = {
        select: (sel: { toOperationNode: () => unknown }) => (seen.selects.push(JSON.stringify(sel.toOperationNode())), q),
        where: () => q,
        executeTakeFirst: async () => {
          seen.runs++;
          if (result instanceof Error) throw result;
          return result;
        },
      };
      return q;
    },
  };
  return { db: db as never, seen };
};

describe('#716 page-size cap: configuration', () => {
  it('defaults to 3 MiB, clamps to [1, 8] MiB, and ignores junk', () => {
    expect(pageMaxYdocBytesFromEnv(undefined)).toBe(3 * MiB);
    expect(pageMaxYdocBytesFromEnv('')).toBe(3 * MiB);
    expect(pageMaxYdocBytesFromEnv('lots')).toBe(3 * MiB);
    expect(pageMaxYdocBytesFromEnv(String(4 * MiB))).toBe(4 * MiB);
    expect(pageMaxYdocBytesFromEnv('1')).toBe(1 * MiB);
    expect(pageMaxYdocBytesFromEnv('-5')).toBe(1 * MiB);
    expect(pageMaxYdocBytesFromEnv(String(64 * MiB))).toBe(8 * MiB);
    expect(pageMaxYdocBytesFromEnv('4194304.9')).toBe(4 * MiB);
    expect(PAGE_MAX_YDOC_BYTES).toBe(3 * MiB); // the spec environment sets no override
  });

  it('only append and prepend accumulate', () => {
    expect(accumulates('append')).toBe(true);
    expect(accumulates('prepend')).toBe(true);
    for (const op of ['replace', undefined, '', 'APPEND']) expect(accumulates(op as string)).toBe(false);
  });

  it('PageTooLargeException: 422 page_too_large; its message derives the configured size', () => {
    const e = new PageTooLargeException(2 * MiB);
    expect(e).toBeInstanceOf(UnprocessableEntityException);
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toEqual({ message: expect.stringContaining('about 2 MiB'), code: 'page_too_large' });
  });
});

describe('#716 page-size cap: the check', () => {
  it('reads coalesce(octet_length(ydoc), 0) from pages — never the bytes themselves', async () => {
    const { db, seen } = fakeDb({ bytes: 42 });
    await expect(storedYdocBytes(db, 'p1')).resolves.toBe(42);
    expect(seen.tables).toEqual(['pages']);
    expect(seen.selects[0]).toContain('coalesce(octet_length(ydoc), 0)');
    expect(seen.selects[0]).not.toMatch(/"ydoc"(?!\))/); // no bare ydoc column selected
  });

  it('a row with no ydoc, or no row, is 0; a numeric string (a bigint driver) is parsed; garbage throws', async () => {
    await expect(storedYdocBytes(fakeDb(undefined).db, 'p')).resolves.toBe(0);
    await expect(storedYdocBytes(fakeDb({ bytes: '1048576' }).db, 'p')).resolves.toBe(MiB);
    await expect(storedYdocBytes(fakeDb({ bytes: 'NaN' }).db, 'p')).rejects.toThrow();
    await expect(storedYdocBytes(fakeDb({ bytes: -1 }).db, 'p')).rejects.toThrow();
  });

  it('over = at or past the cap; under is allowed', async () => {
    await expect(isOverPageCap(fakeDb({ bytes: 3 * MiB }).db, 'p', 'append')).resolves.toBe(true);
    await expect(isOverPageCap(fakeDb({ bytes: 3 * MiB - 1 }).db, 'p', 'append')).resolves.toBe(false);
    await expect(isOverPageCap(fakeDb({ bytes: 10 }).db, 'p', 'prepend', 10)).resolves.toBe(true);
  });

  it('a replace (or no operation) never queries', async () => {
    const { db, seen } = fakeDb({ bytes: 50 * MiB });
    await expect(isOverPageCap(db, 'p', 'replace')).resolves.toBe(false);
    await expect(isOverPageCap(db, 'p', undefined)).resolves.toBe(false);
    expect(seen.runs).toBe(0);
  });

  it('a DB error refuses with a retryable 503 — never "not over"; so does a missing handle', async () => {
    const err = await isOverPageCap(fakeDb(new Error('connection reset')).db, 'p', 'append').catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'engine_busy' });
    await expect(isOverPageCap(undefined, 'p', 'append')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('assertPageCanGrow throws PageTooLargeException over the cap, and resolves under it', async () => {
    await expect(assertPageCanGrow(fakeDb({ bytes: 3 * MiB }).db, 'p', 'append')).rejects.toBeInstanceOf(
      PageTooLargeException,
    );
    await expect(assertPageCanGrow(fakeDb({ bytes: 1 }).db, 'p', 'append')).resolves.toBeUndefined();
  });
});

describe('#716 page growth lock', () => {
  it('serializes appends to one page; other pages and other operations are not held', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    const a = withPageGrowthLock('p1', 'append', async () => {
      order.push('a:start');
      await aHeld;
      order.push('a:end');
    });
    const b = withPageGrowthLock('p1', 'prepend', async () => void order.push('b'));
    const other = withPageGrowthLock('p2', 'append', async () => void order.push('other-page'));
    const replace = withPageGrowthLock('p1', 'replace', async () => void order.push('replace'));
    await other;
    await replace;
    expect([...order].sort()).toEqual(['a:start', 'other-page', 'replace']); // b is held behind a
    releaseA();
    await a;
    await b;
    expect(order.slice(-2)).toEqual(['a:end', 'b']);
    expect(growthLockCount()).toBe(0); // no entry outlives its last writer
  });

  it('a wait that runs out is a retryable 503 engine_busy and runs nothing; the holder is unaffected', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = withPageGrowthLock('p3', 'append', () => held);
    const fn = jest.fn(async () => undefined);
    const err = await withPageGrowthLock('p3', 'append', fn, 5).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'engine_busy' });
    expect(fn).not.toHaveBeenCalled();
    release();
    await holder;
    expect(growthLockCount()).toBe(0);
  });

  it('the lock is released when fn throws', async () => {
    await expect(withPageGrowthLock('p4', 'append', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(withPageGrowthLock('p4', 'append', async () => 'ok', 5)).resolves.toBe('ok');
    expect(growthLockCount()).toBe(0);
  });

  it('applyWithinPageCap re-checks the cap under the lock before applying (a replace is not checked)', async () => {
    const apply = jest.fn(async () => 'applied');
    await expect(applyWithinPageCap(fakeDb({ bytes: 3 * MiB }).db, 'p5', 'append', apply)).rejects.toBeInstanceOf(
      PageTooLargeException,
    );
    expect(apply).not.toHaveBeenCalled();
    const replaceDb = fakeDb({ bytes: 50 * MiB });
    await expect(applyWithinPageCap(replaceDb.db, 'p5', 'replace', apply)).resolves.toBe('applied');
    expect(replaceDb.seen.runs).toBe(0);
  });
});

/**
 * Seam #121: native `/api/pages/update` (SPA sessions, the attachment auto-embed, `/v1` JSON writes that skip the
 * conditional route). `PageService.update` refuses an append/prepend to a page at the cap BEFORE its row write (a
 * refused write renames nothing) and before the parse, which also precedes the row write (#781); `updatePageContent`
 * re-checks under the page's growth lock
 * right before the collab event.
 */
describe('#716 seam #121: PageService.update / updatePageContent', () => {
  const self = (bytes: number | Error | (() => number), calls: string[]) => {
    const sizeOf = () => (typeof bytes === 'function' ? bytes() : bytes);
    const db = {
      selectFrom: () => {
        const q = {
          select: () => q,
          where: () => q,
          executeTakeFirst: async () => {
            calls.push('size');
            if (bytes instanceof Error) throw bytes;
            return { bytes: sizeOf() };
          },
        };
        return q;
      },
    };
    const s = {
      db,
      logger: { warn: jest.fn() },
      pageRepo: {
        updatePage: jest.fn(async () => void calls.push('updatePage')),
        findById: jest.fn(async () => ({ id: 'p1' })),
      },
      generalQueue: { add: jest.fn(async () => undefined) },
      parseProsemirrorContent: jest.fn(async () => (calls.push('parse'), { type: 'doc' })),
      collaborationGateway: { handleYjsEvent: jest.fn(async () => void calls.push('yjs')) },
    } as Record<string, unknown>;
    s.updatePageContent = PageService.prototype.updatePageContent;
    return s;
  };
  const update = (bytes: number | Error | (() => number), operation: string) => {
    const calls: string[] = [];
    const s = self(bytes, calls);
    const run = PageService.prototype.update.call(
      s,
      { id: 'p1', contributorIds: [], spaceId: 's', workspaceId: 'w' } as never,
      { pageId: 'p1', title: 'Renamed', content: '# x', operation, format: 'markdown' } as never,
      { id: 'u' } as never,
    );
    return { run, calls };
  };

  it('refuses an append to a page at the cap with 422 BEFORE the row write (no rename), the parse and the collab event', async () => {
    const { run, calls } = update(3 * MiB, 'append');
    await expect(run).rejects.toBeInstanceOf(PageTooLargeException);
    expect(calls).toEqual(['size']);
  });

  it('a DB error refuses too (503), before the row write and the parse', async () => {
    const { run, calls } = update(new Error('down'), 'prepend');
    await expect(run).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls).toEqual(['size']);
  });

  it('an append under the cap: entry check, parse, row write, re-check under the lock, collab event', async () => {
    const a = update(1, 'append');
    await a.run;
    expect(a.calls).toEqual(['size', 'parse', 'updatePage', 'size', 'yjs']); // #781: parsed before the row write
  });

  it('the re-check under the lock refuses an append another write pushed over the cap after the entry check', async () => {
    let bytes = 3 * MiB - 1;
    const calls: string[] = [];
    const s = self(() => bytes, calls);
    (s.parseProsemirrorContent as jest.Mock).mockImplementation(async () => {
      bytes = 3 * MiB; // another append stored while this one was parsing
      return { type: 'doc' };
    });
    const run = PageService.prototype.updatePageContent.call(s, 'p1', '# x', 'append', 'markdown', { id: 'u' } as never);
    await expect(run).rejects.toBeInstanceOf(PageTooLargeException);
    expect(calls).toEqual(['size']);
  });

  it('a replace is never checked', async () => {
    const r = update(50 * MiB, 'replace');
    await r.run;
    expect(r.calls).toEqual(['parse', 'updatePage', 'yjs']);
  });
});
