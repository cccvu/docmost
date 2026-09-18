import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';
// CCC integration seam (UPSTREAM_MODIFICATIONS.md + authz/route-guard/import-boundary.spec.ts):
// the conditional page write compares the LIVE document against a caller-supplied digest, and the digest
// function is cross-service contract code that must live beside its shared vectors in authz/.
import { stableHash } from '../authz/page-write/stable-hash';
import {
  ConditionalUpdateOutcome,
  FlushPageContentOutcome,
} from '../authz/page-write/collab-outcomes';
// #390: the settle must report failure (not a false success) when the store it just ran failed to persist.
import { hasStoreFailure } from '../authz/page-write/store-failure-registry';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  constructor() {}

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      // CCC integration seam (UPSTREAM_MODIFICATIONS.md): force-disconnect a user's live sessions on a
      // document when their access is revoked mid-session. Runs on the doc-owning node (RedisSync
      // routes here); pure connection logic — the authorization decision is made in apps/server/src/authz/.
      forceDisconnect: async (documentName: string, payload: { userId: string }) => {
        const doc = hocuspocus.documents.get(documentName);
        if (!doc) return;
        for (const connection of doc.getConnections()) {
          if (connection.context?.user?.id === payload.userId) {
            connection.close();
          }
        }
      },
      // CCC integration seam (UPSTREAM_MODIFICATIONS.md): run a document's PENDING debounced
      // onStoreDocument NOW, on the doc-owning node (RedisSync routes here). Pure collab mechanics — no
      // authorization, no policy; the caller in apps/server/src/authz/ owns that. Used by the platform so
      // its optimistic-concurrency anchor is compared against settled content rather than a `pages` row
      // that trails the live Y.Doc by up to `maxDebounce` (issue 282).
      //
      // `executeNow` re-runs the ALREADY-SCHEDULED store closure with its ORIGINAL payload, so
      // `lastUpdatedById` stays the human who actually typed. Opening a direct connection and transacting
      // a no-op would instead store under THIS caller's context — mis-attributing the edit, or (with an
      // empty context) throwing a TypeError that persistence.extension's catch swallows, silently dropping
      // the store. It is also the primitive Hocuspocus itself uses on last-client-disconnect.
      //
      // Never throws: an uncaught rejection here is an unhandled rejection locally and, cross-node, hangs
      // RedisSync's customEvent reply until its TTL.
      flushPageContent: async (
        documentName: string,
        payload?: { withDigest?: boolean },
      ): Promise<FlushPageContentOutcome> => {
        const doc = hocuspocus.documents.get(documentName);
        // Not resident on the owning node ⇒ no unpersisted delta exists (Hocuspocus refuses to unload a
        // document while a store is debounced, executing, or holding saveMutex), so the row is already
        // authoritative and there is nothing to flush. `reason` is absent here ON PURPOSE: this is a
        // successful settle with nothing to do, which the caller must NOT confuse with a failure.
        if (!doc) return { flushed: false };
        const debounceId = `onStoreDocument-${documentName}`;
        try {
          if (hocuspocus.debouncer.isDebounced(debounceId)) {
            await hocuspocus.debouncer.executeNow(debounceId);
          }
          // Drain a store that was already executing when we arrived.
          await doc.saveMutex.runExclusive(async () => undefined);
          // #390: if the store we just forced (or drained) FAILED to persist, the row does not hold what this
          // document contains — reporting success here would let a guarded /v1 write trust a version the row
          // never received. `reason: 'error'` fails the guarded write closed (503), same as a thrown settle.
          if (hasStoreFailure(doc)) {
            return { flushed: false, reason: 'error' };
          }
          // Serializing + hashing a whole document is not free and it runs on the event loop every live
          // editor on this node shares, so only do it when the caller is going to use the digest. A read
          // settle (`GET ?settle=true`) wants the store, never the version.
          if (!payload?.withDigest) return { flushed: true };
          // Hand back the LIVE document's digest so a follow-up conditional write can name a version this
          // server will actually recognise. The caller must not derive one from the `pages` row: content
          // authored through the API is stored verbatim, while this serialization fills in ProseMirror's
          // default attributes (e.g. `attrs: {indent: 0}`), so the two never hash alike until a store has
          // rewritten the row — and a caller comparing row-derived digests against a resident document
          // would 412 on every attempt, forever, with a re-read that never changes anything.
          return {
            flushed: true,
            contentDigest: stableHash(
              TiptapTransformer.fromYdoc(doc, 'default'),
            ),
          };
        } catch (err) {
          this.logger.warn(
            `flushPageContent failed for ${documentName}: ${err?.['message']}`,
          );
          // `reason: 'error'` is load-bearing. A bare `{ flushed: false }` is ALSO what a non-resident
          // document returns, and that one means "safe, the row is authoritative". Collapsing the two
          // lets a guarded write silently fall back to an unconditional one against a stale row — the
          // exact lost update this seam exists to prevent (#282). The caller fails closed on this.
          return { flushed: false, reason: 'error' };
        }
      },
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { prosemirrorJson, operation, user } = payload;
        this.logger.debug('Updating page content via yjs', documentName);
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => this.applyContentOperation(doc, prosemirrorJson, operation),
        );
      },
      // CCC integration seam (UPSTREAM_MODIFICATIONS.md): a COMPARE-AND-SWAP content write (#282).
      //
      // `updatePageContent` above applies unconditionally, so a caller that checked a version a moment
      // earlier can still clobber a keystroke that landed in between. Here the compare happens INSIDE the
      // same transaction as the mutation: `transact` invokes this callback synchronously and incoming
      // websocket frames are handled on separate ticks, so nothing can interleave between reading the
      // document and replacing it. That makes the precondition atomic with respect to live editors.
      //
      // Skips the compare when the caller supplied NO digest. The settle omits one when it found no
      // resident document, which means no live editors, no unpersisted delta (Hocuspocus refuses to unload
      // while a store is pending) and therefore a row-based check that was already authoritative — and a
      // page written through the API stores its content verbatim while this serialization normalizes it,
      // so comparing there would 412 forever. Absence of a digest is the whole signal; residency is NOT
      // re-tested here, because a document that was resident at settle time and unloaded since is exactly
      // the concurrent-edit race this must catch, not an excuse to skip the check.
      //
      // Returns an outcome and NEVER throws: cross-node, a throwing handler never publishes its RedisSync
      // reply and hangs the caller until the custom-event TTL.
      conditionalUpdatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
          expectedContentHash?: string;
        },
      ): Promise<ConditionalUpdateOutcome> => {
        const { prosemirrorJson, operation, user, expectedContentHash } =
          payload;
        let outcome: ConditionalUpdateOutcome = {
          applied: false,
          reason: 'unknown',
        };
        try {
          // Refuse the COMMON case before opening a direct connection. `DirectConnection.transact()` and
          // `.disconnect()` each run an immediate store, and on a refusal that store is not a no-op: the
          // live document has moved past the settled row by construction, so it would persist a human's
          // in-flight text under THIS caller's context — reassigning `lastUpdatedById` to the API/MCP
          // service account, rotating `updatedAt`, broadcasting `page.updated` under the caller's name,
          // firing the history/AI/mention jobs, and cancelling the human's own pending store. Checking the
          // resident document first means a refusal normally touches nothing at all.
          //
          // RESIDUAL, stated rather than implied: a refusal detected by the in-transaction compare below
          // — an edit that lands while this connection is opening, a window of an event-loop turn or two
          // — still pays `disconnect()`'s store, and so still reattributes that edit to the API caller.
          // No content is lost either way; the pre-check shrinks this from "every 412" to "a 412 that
          // races connection setup".
          const resident = expectedContentHash
            ? hocuspocus.documents.get(documentName)
            : undefined;
          if (
            resident &&
            stableHash(TiptapTransformer.fromYdoc(resident, 'default')) !==
              expectedContentHash
          ) {
            return { applied: false, reason: 'precondition' };
          }
          await this.withYdocConnection(
            hocuspocus,
            documentName,
            { user },
            (doc) => {
              // The authoritative compare: inside the transaction, so an edit cannot land between it and
              // the mutation. The pre-check above is an optimization, not a substitute — it cannot see an
              // edit that arrives while the connection is opening.
              if (
                expectedContentHash &&
                stableHash(TiptapTransformer.fromYdoc(doc, 'default')) !==
                  expectedContentHash
              ) {
                outcome = { applied: false, reason: 'precondition' };
                return;
              }
              this.applyContentOperation(doc, prosemirrorJson, operation);
              outcome = { applied: true };
            },
          );
        } catch (err) {
          this.logger.warn(
            `conditionalUpdatePageContent failed for ${documentName}: ${err?.['message']}`,
          );
          return { applied: false, reason: 'error' };
        }
        return outcome;
      },
    };
  }

  /**
   * Apply a content operation to a live document. Extracted verbatim from `updatePageContent` so the
   * conditional write (#282) applies byte-identical semantics — there must be exactly one definition of
   * what `replace`/`append`/`prepend` mean.
   */
  private applyContentOperation(
    doc: Document,
    prosemirrorJson: any,
    operation: string,
  ): void {
    const fragment = doc.getXmlFragment('default');

    if (operation === 'replace') {
      // BUILD BEFORE DELETE (#342). `TiptapTransformer.toYdoc` throws on content it cannot convert
      // (a body that passed `jsonToNode` but that the Yjs transformer rejects). If the fragment were
      // emptied first, that throw would leave an empty document behind, and the connection's closing
      // `disconnect()` store would persist it — silently WIPING the page while the request also fails.
      // Encoding the new state first means a conversion failure aborts before any mutation, so the
      // original content survives and the closing store re-persists it unchanged.
      const newDoc = TiptapTransformer.toYdoc(
        prosemirrorJson,
        'default',
        tiptapExtensions,
      );
      const update = Y.encodeStateAsUpdate(newDoc);

      if (fragment.length > 0) {
        fragment.delete(0, fragment.length);
      }
      Y.applyUpdate(doc, update);
    } else {
      const newContent = prosemirrorJson.content || [];
      const yElements = newContent.map(prosemirrorNodeToYElement);
      const position = operation === 'prepend' ? 0 : fragment.length;
      fragment.insert(position, yElements);
    }
  }

  async withYdocConnection(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    fn: (doc: Document) => void,
  ): Promise<void> {
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }
}
