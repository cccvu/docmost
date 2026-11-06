import { importPageLevels, type ImportLevelPage } from './import-page-levels';

/**
 * #716 I1: the zip import's levels are upstream's exactly, in linear time. Run in CI via the `docmost-authz` job's jest
 * glob (`… src/editor-compat …`).
 */

/** Upstream's calculateLevels (file-import-task.service.ts at v0.95.0), verbatim but for the closure: the reference. */
function upstreamLevels<P extends ImportLevelPage>(pagesMap: Map<string, P>): Map<number, Array<[string, P]>> {
  const pagesByLevel = new Map<number, Array<[string, P]>>();
  const pageLevel = new Map<string, number>();
  const queue: Array<{ filePath: string; level: number }> = [];
  for (const [filePath, page] of pagesMap.entries()) {
    if (!page.parentPageId) {
      queue.push({ filePath, level: 0 });
      pageLevel.set(filePath, 0);
    }
  }
  while (queue.length > 0) {
    const { filePath, level } = queue.shift()!;
    const currentPage = pagesMap.get(filePath)!;
    for (const [childFilePath, childPage] of pagesMap.entries()) {
      if (childPage.parentPageId === currentPage.id && !pageLevel.has(childFilePath)) {
        pageLevel.set(childFilePath, level + 1);
        queue.push({ filePath: childFilePath, level: level + 1 });
      }
    }
  }
  for (const [filePath, page] of pagesMap.entries()) {
    const level = pageLevel.get(filePath) || 0;
    if (!pagesByLevel.has(level)) pagesByLevel.set(level, []);
    pagesByLevel.get(level)!.push([filePath, page]);
  }
  return pagesByLevel;
}

/** A deterministic forest: some roots, children pointing at earlier or later pages, a few orphans, a cycle. */
function forest(n: number, seed: number): Map<string, ImportLevelPage> {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ids = Array.from({ length: n }, (_, i) => `id-${seed}-${i}`);
  const order = ids.map((_, i) => i).sort(() => rnd() - 0.5); // map order differs from id order
  const map = new Map<string, ImportLevelPage>();
  for (const i of order) {
    const r = rnd();
    const parentPageId =
      r < 0.15 ? null : r < 0.2 ? `missing-${i}` : ids[Math.floor(rnd() * n)] === ids[i] ? null : ids[Math.floor(rnd() * n)];
    map.set(`docs/p${i}.md`, { id: ids[i], parentPageId });
  }
  if (n >= 2) {
    // a two-page cycle, unreachable from any root
    map.set('cycle/a.md', { id: 'cyc-a', parentPageId: 'cyc-b' });
    map.set('cycle/b.md', { id: 'cyc-b', parentPageId: 'cyc-a' });
  }
  return map;
}

/** A Map that counts every entry any iteration of it yields, and every `get`. */
class CountingMap<K, V> extends Map<K, V> {
  steps = 0;
  override get(key: K): V | undefined {
    this.steps++;
    return super.get(key);
  }
  override *entries(): MapIterator<[K, V]> {
    for (const e of super.entries()) {
      this.steps++;
      yield e;
    }
  }
  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

describe('importPageLevels (#716 I1)', () => {
  it('is upstream’s calculateLevels exactly: same levels, same order inside each level', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      for (const n of [0, 1, 5, 40, 300]) {
        const map = forest(n, seed);
        expect([...importPageLevels(map)]).toEqual([...upstreamLevels(map)]);
      }
    }
  });

  it('nested folders: a parent is always at a lower level than its child', () => {
    const map = new Map<string, ImportLevelPage>([
      ['a/b/c.md', { id: 'c', parentPageId: 'b' }],
      ['a/b.md', { id: 'b', parentPageId: 'a' }],
      ['a.md', { id: 'a', parentPageId: null }],
    ]);
    expect([...importPageLevels(map)].map(([level, pages]) => [level, pages.map(([p]) => p)])).toEqual([
      [2, ['a/b/c.md']],
      [1, ['a/b.md']],
      [0, ['a.md']],
    ]);
  });

  it('takes linear steps on 20k pages, a deep chain and a wide fan-out (upstream: ~N² = 4·10⁸)', () => {
    const n = 20_000;
    const chain = new CountingMap<string, ImportLevelPage>();
    for (let i = n - 1; i >= 0; i--) chain.set(`p${i}.md`, { id: `c${i}`, parentPageId: i === 0 ? null : `c${i - 1}` });
    const fan = new CountingMap<string, ImportLevelPage>();
    fan.set('root.md', { id: 'root', parentPageId: null });
    for (let i = 0; i < n - 1; i++) fan.set(`f${i}.md`, { id: `f${i}`, parentPageId: 'root' });
    for (const map of [chain, fan]) {
      const levels = importPageLevels(map);
      expect([...levels.values()].reduce((sum, l) => sum + l.length, 0)).toBe(n);
      expect(map.steps).toBeLessThanOrEqual(3 * n); // two passes + one `get` per page
    }
    expect(Math.max(...importPageLevels(chain).keys())).toBe(n - 1);
    // Anti-vacuity: the same counter on upstream's algorithm over a small chain is quadratic.
    const small = new CountingMap<string, ImportLevelPage>();
    for (let i = 0; i < 200; i++) small.set(`p${i}.md`, { id: `c${i}`, parentPageId: i === 0 ? null : `c${i - 1}` });
    upstreamLevels(small);
    expect(small.steps).toBeGreaterThan(200 * 200);
  });
});
