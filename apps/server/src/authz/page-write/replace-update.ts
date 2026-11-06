/**
 * CCC integration — NOT upstream Docmost code (#716, UPSTREAM_MODIFICATIONS.md §2).
 *
 * Build the Yjs update a content `replace` applies, BEFORE the live document is touched. It is a pure function of the
 * request (`toYdoc` + `encodeStateAsUpdate` on a fresh document), so building it outside the direct connection's
 * transaction changes no concurrency semantics, and:
 *   - it takes 3–4 full-page passes out of the one synchronous chunk that holds the CAS and the mutation (the longest
 *     event-loop block a content write had, #716 M1); the caller yields one tick after it, so the build and that chunk
 *     are separate macrotasks;
 *   - BUILD-BEFORE-DELETE (#342) gets stronger: content the Yjs transformer rejects now fails before any direct
 *     connection is opened, so no store runs and nothing is reattributed, rather than after the open.
 */
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { prosemirrorNodeToYElement, tiptapExtensions } from '../../collaboration/collaboration.util';

/** The update that turns an empty `default` fragment into `prosemirrorJson`. Throws on content Yjs cannot hold. */
export function buildReplaceUpdate(prosemirrorJson: unknown): Uint8Array {
  const newDoc = TiptapTransformer.toYdoc(prosemirrorJson as never, 'default', tiptapExtensions);
  return Y.encodeStateAsUpdate(newDoc);
}

/**
 * A content operation built ahead of the live document (#716): what `applyContentOperation` then applies with no
 * conversion left to do. For an append/prepend the new nodes are built as Yjs preliminary elements (integrated by the
 * insert), so a node the converter rejects throws HERE, before the connection opens and before the mutation begins:
 * a failure is then "nothing applied" (a retryable error), never `applied_unconfirmed`, and only the insert and the
 * key record run inside the transaction (#429: the key is recorded right after the content it rides with).
 */
export type PreparedContent =
  | { kind: 'replace'; update: Uint8Array }
  | { kind: 'insert'; atStart: boolean; elements: unknown[] };

export function prepareContentOperation(prosemirrorJson: unknown, operation: string): PreparedContent {
  if (operation === 'replace') return { kind: 'replace', update: buildReplaceUpdate(prosemirrorJson) };
  const content = ((prosemirrorJson as { content?: unknown[] } | null)?.content || []) as unknown[];
  return {
    kind: 'insert',
    atStart: operation === 'prepend',
    elements: content.map((n) => prosemirrorNodeToYElement(n as never)),
  };
}

/** Let other macrotasks (websocket frames, health checks, timers) run between two heavy synchronous steps. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
