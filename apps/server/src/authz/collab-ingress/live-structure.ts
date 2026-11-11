/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * What a compaction of a page keeps, and whether that is under the soft caps. The one rule shared by the update guard
 * (a frame past a cap: drain or page-full; a page past a soft cap: request) and the load path (authz/page-write/
 * compaction.ts, `loadStoredYdoc`), so a page is never drained or queued for a compaction that cannot help it: one
 * whose visible content, not its history, is what is too big.
 */
import * as Y from 'yjs';
import { softCap } from './doc-bounds';

/** A page's live structure: its non-deleted structs, and the most live children of one element. */
export interface LiveStructure {
  structs: number;
  children: number;
}

/**
 * What a compaction of `doc` keeps: its live (non-deleted) structs, and the most live children of one element (the
 * `default` root included; the children cap's count). Pure reads, O(structs): an explicit stack, never recursion.
 */
export function liveStructure(doc: Y.Doc): LiveStructure {
  let structs = 0;
  for (const array of doc.store.clients.values()) for (const struct of array) if (!struct.deleted) structs++;
  let children = 0;
  const root = doc.share.get('default');
  const stack: Y.AbstractType<any>[] = root ? [root] : [];
  while (stack.length) {
    const type = stack.pop()!;
    children = Math.max(children, type._length);
    for (let item = type._start; item !== null; item = item.right) {
      // Exactly Y.XmlElement (XmlHook extends Y.Map, XmlText extends Y.Text): the update guard's `kindOf` element.
      if (!item.deleted && item.content instanceof Y.ContentType && item.content.type.constructor === Y.XmlElement) {
        stack.push(item.content.type);
      }
    }
  }
  return { structs, children };
}

/**
 * Would a compaction bring a page of `live` structure under the soft caps? Compaction keeps the live structs (at most:
 * the rebuild merges runs), every live child and one client id, so the client-id cap always helps and the structs and
 * children caps decide.
 */
export function compactionWouldHelp(live: LiveStructure, caps: { structs: number; children: number }): boolean {
  return live.structs < softCap(caps.structs) && live.children < softCap(caps.children);
}
