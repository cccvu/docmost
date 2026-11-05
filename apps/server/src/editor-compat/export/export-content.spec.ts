import { ExportContentSource, loadExportContent } from './export-content';
import { ExportTooLargeException } from './export-limits';

/** #699 — page content is loaded only once the export set is known to fit. Fork-owned. */

const MiB = 1024 * 1024;

function source(stored: number, text: number, rows: Array<{ id: string; content: unknown }>) {
  return {
    storedBytes: jest.fn(async () => stored),
    textBytes: jest.fn(async () => text),
    contents: jest.fn(async () => rows),
  } satisfies ExportContentSource;
}

const LIMITS = { contentBytes: 16 * MiB, maxEntries: 65_000 };

describe('loadExportContent (#699)', () => {
  it('loads content for exactly the given pages, in place, keeping order and objects', async () => {
    const pages = [{ id: 'b', title: 'B' }, { id: 'a', title: 'A' }, { id: 'gone', title: 'G' }];
    const src = source(10, 20, [
      { id: 'a', content: { type: 'doc', n: 'a' } },
      { id: 'b', content: { type: 'doc', n: 'b' } },
    ]);
    const out = await loadExportContent(src, pages, LIMITS);
    expect(out).toBe(pages);
    expect(pages.map((p) => (p as any).content?.n ?? null)).toEqual(['b', 'a', null]);
    expect(src.storedBytes).toHaveBeenCalledWith(['b', 'a', 'gone']);
    expect(src.contents).toHaveBeenCalledWith(['b', 'a', 'gone']);
  });

  it('refuses on the stored size without ever detoasting the text or loading content', async () => {
    const src = source(16 * MiB + 1, 0, []);
    const err = await loadExportContent(src, [{ id: 'a' }], LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(ExportTooLargeException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'export_too_large' });
    expect(err.getResponse().message).toMatch(/page content totals .* above the 16 MiB limit\. Export a smaller subtree\./);
    expect(src.textBytes).not.toHaveBeenCalled();
    expect(src.contents).not.toHaveBeenCalled();
  });

  it('refuses on the TEXT size when compressible content slips under the stored-size check', async () => {
    // pglz stores repetitive content ~60× smaller (measured): the heap pays for the text, not the stored size.
    const src = source(300 * 1024, 18 * MiB, []);
    await expect(loadExportContent(src, [{ id: 'a' }], LIMITS)).rejects.toBeInstanceOf(ExportTooLargeException);
    expect(src.contents).not.toHaveBeenCalled();
  });

  it('refuses more pages than a zip32 archive can list, before any query', async () => {
    const src = source(0, 0, []);
    const pages = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}` }));
    await expect(loadExportContent(src, pages, { ...LIMITS, maxEntries: 10 })).rejects.toMatchObject({ reason: 'pages' });
    expect(src.storedBytes).not.toHaveBeenCalled();
  });

  it('exactly at the bound is allowed', async () => {
    const src = source(16 * MiB, 16 * MiB, [{ id: 'a', content: {} }]);
    await expect(loadExportContent(src, [{ id: 'a' }], LIMITS)).resolves.toHaveLength(1);
  });

  it('no pages: no queries', async () => {
    const src = source(0, 0, []);
    await expect(loadExportContent(src, [], LIMITS)).resolves.toEqual([]);
    expect(src.storedBytes).not.toHaveBeenCalled();
  });
});
