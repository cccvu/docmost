/**
 * #716 R4 / #790 — the first of a direct write's two stores (ADR 0029, ADR 0031 amendment).
 *
 * Under Hocuspocus 3.4.4, `DirectConnection.transact()` stored the document at once and `disconnect()` stored it again.
 * The second store was the in-request retry of a failed first one (and is skipped after a successful one:
 * store-failure-registry's `isStoreCurrent`). Hocuspocus 4.x's `transact()` stores nothing: the change only schedules a
 * debounced store, which `disconnect()`'s immediate store then replaces, so a write got ONE attempt. This restores the
 * first: right after the transaction, an immediate store through Hocuspocus's public `storeDocumentHooks`, with the
 * payload `disconnect()` builds (this caller's context, so attribution is unchanged). It replaces the scheduled one.
 *
 * Never rejects. Hocuspocus 4.x catches a failed store itself and the persistence extension records it (#390); anything
 * else that throws here is recorded as a store failure too, so the handler answers "outcome unknown" (#716 R4) unless
 * `disconnect()`'s retry then succeeds and clears it.
 */
import type { Document, Hocuspocus } from '@hocuspocus/server';
import { recordStoreFailure } from './store-failure-registry';

/** The part of Hocuspocus's `DirectConnection` read here. */
export interface DirectConnectionLike {
  document: Document | null;
  context: unknown;
}

export async function storeDirectWriteNow(
  hocuspocus: Pick<Hocuspocus, 'storeDocumentHooks'>,
  connection: DirectConnectionLike,
): Promise<void> {
  const document = connection.document;
  if (!document) return;
  try {
    await hocuspocus.storeDocumentHooks(
      document,
      {
        instance: hocuspocus as Hocuspocus,
        clientsCount: document.getConnectionsCount(),
        document,
        documentName: document.name,
        lastContext: connection.context,
        lastTransactionOrigin: { source: 'local', context: connection.context },
      },
      true,
    );
  } catch {
    recordStoreFailure(document);
  }
}
