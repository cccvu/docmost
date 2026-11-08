/**
 * CCC integration — NOT upstream Docmost code (#716, #731, UPSTREAM_MODIFICATIONS.md §2).
 *
 * Build a content operation BEFORE the live document is touched. It is a pure function of the request, so building it
 * outside the direct connection's transaction changes no concurrency semantics, and:
 *   - it keeps the conversion out of the one synchronous chunk that holds the CAS and the mutation (the longest
 *     event-loop block a content write had, #716 M1); the caller yields a loop turn after it (`yieldToEventLoop`), so
 *     the build and that chunk are separate blocks, with an I/O poll between them;
 *   - BUILD-BEFORE-DELETE (#342) gets stronger: content the schema rejects fails before any direct connection is
 *     opened, so no store runs and nothing is reattributed, rather than after the open.
 *
 * #731: a replace is built like an append, as Yjs preliminary types (prelim-content.ts) that the insert integrates,
 * rather than as a second Y.Doc that was encoded here and decoded and applied inside the transaction. Both operations
 * now use the same builder, the same port of `TiptapTransformer.toYdoc`.
 */
import { randomInt } from 'node:crypto';
import type * as Y from 'yjs';
import { buildPrelimContent } from './prelim-content';

/**
 * A content operation built ahead of the live document (#716): what `applyContentOperation` then applies with no
 * conversion left to do. The new nodes are Yjs preliminary types (integrated by the insert), so a node the schema
 * rejects throws HERE, before the connection opens and before the mutation begins: a failure is then "nothing applied"
 * (a retryable error), never `applied_unconfirmed`, and only the delete (a replace), the insert and the key record run
 * inside the transaction (#429: the key is recorded right after the content it rides with).
 */
export type PreparedContent =
  | { kind: 'replace'; elements: Array<Y.XmlElement | Y.XmlText> }
  | { kind: 'insert'; atStart: boolean; elements: Array<Y.XmlElement | Y.XmlText> };

export function prepareContentOperation(prosemirrorJson: unknown, operation: string): PreparedContent {
  if (operation === 'replace') return { kind: 'replace', elements: buildPrelimContent(prosemirrorJson) };
  return {
    kind: 'insert',
    atStart: operation === 'prepend',
    // An append/prepend of no document inserts nothing (the pre-#731 behaviour).
    elements: prosemirrorJson ? buildPrelimContent(prosemirrorJson) : [],
  };
}

/**
 * Insert a REPLACE's content (into the fragment the caller just emptied) the way the pre-#731 update from `toYdoc`
 * landed, so the live document and its stored ydoc stay as they were, minus the second document:
 *   - under a client id of its own (the update came from a fresh Y.Doc). Under the live document's own id, every
 *     replace's structs and the previous replaces' tombstones pile into ONE client's struct array, and the
 *     transaction's cleanup (merging and garbage-collecting the deleted structs, which splices that array) then grows
 *     with the page's history: on a ~40k-node page, 150 ms for the first replace, 400–700 ms from the second on,
 *     against 150–190 ms with an id per replace. The document's own id is back before this returns (inside the same
 *     transaction), so nothing after it (the #429 key) writes under the other one.
 *   - after the LAST item of the fragment, tombstones included (an index insert at 0 would name the first tombstone
 *     as every new item's right origin: ~6 more bytes per top-level node, kept in every later tombstone).
 */
export function insertAsOwnClient(doc: Y.Doc, fragment: Y.XmlFragment, elements: Array<Y.XmlElement | Y.XmlText>): void {
  if (elements.length === 0) return;
  let last = fragment._start;
  while (last?.right) last = last.right;
  const own = doc.clientID;
  let id: number;
  do id = randomInt(0, 2 ** 32);
  while (id === own || doc.store.clients.has(id));
  doc.clientID = id;
  try {
    if (last) fragment.insertAfter(last as never, elements);
    else fragment.insert(0, elements);
  } finally {
    doc.clientID = own;
  }
}

// #731: the loop yield lives in its own dependency-free module (the persistence seam uses it too); re-exported for the
// handler's existing import.
export { yieldToEventLoop } from './yield-to-event-loop';
