/**
 * #716 I1 — the zip import's page levels, in linear time. Fork-owned.
 *
 * `FileImportTaskService.processGenericImport` (seam §176) inserts an archive's pages level by level, parents first,
 * inside one transaction. Upstream computed the levels with a BFS that, for every page it dequeued, scanned EVERY page
 * for its children, and dequeued with `Array.shift()`: O(N²) twice over, on the main thread, before the import's first
 * insert (20k pages ≈ 4·10⁸ steps). This is the same BFS over a children map built once, with a read index: O(N).
 *
 * The output is upstream's exactly: roots (no `parentPageId`) at level 0 in map order, each page's children one level
 * below it in map order, a page whose parent is not in the archive (or that sits in a cycle) at level 0, and every
 * level's pages in map order.
 */
export interface ImportLevelPage {
  id: string;
  parentPageId?: string | null;
}

export function importPageLevels<P extends ImportLevelPage>(pagesMap: Map<string, P>): Map<number, Array<[string, P]>> {
  const children = new Map<string, Array<[string, P]>>();
  const queue: Array<{ filePath: string; level: number }> = [];
  const pageLevel = new Map<string, number>();
  for (const [filePath, page] of pagesMap) {
    if (!page.parentPageId) {
      queue.push({ filePath, level: 0 });
      pageLevel.set(filePath, 0);
    } else {
      let list = children.get(page.parentPageId);
      if (!list) children.set(page.parentPageId, (list = []));
      list.push([filePath, page]);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const { filePath, level } = queue[i];
    const current = pagesMap.get(filePath)!;
    for (const [childPath] of children.get(current.id) ?? []) {
      if (!pageLevel.has(childPath)) {
        pageLevel.set(childPath, level + 1);
        queue.push({ filePath: childPath, level: level + 1 });
      }
    }
  }
  const pagesByLevel = new Map<number, Array<[string, P]>>();
  for (const [filePath, page] of pagesMap) {
    const level = pageLevel.get(filePath) || 0;
    let list = pagesByLevel.get(level);
    if (!list) pagesByLevel.set(level, (list = []));
    list.push([filePath, page]);
  }
  return pagesByLevel;
}
