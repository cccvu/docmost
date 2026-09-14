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
      forceDisconnect: async (
        documentName: string,
        payload: { userId: string },
      ) => {
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
      flushPageContent: async (documentName: string) => {
        const doc = hocuspocus.documents.get(documentName);
        // Not resident on the owning node ⇒ no unpersisted delta exists (Hocuspocus refuses to unload a
        // document while a store is debounced, executing, or holding saveMutex), so the row is already
        // authoritative and there is nothing to flush.
        if (!doc) return { flushed: false };
        const debounceId = `onStoreDocument-${documentName}`;
        try {
          if (hocuspocus.debouncer.isDebounced(debounceId)) {
            await hocuspocus.debouncer.executeNow(debounceId);
          }
          // Drain a store that was already executing when we arrived.
          await doc.saveMutex.runExclusive(async () => undefined);
        } catch (err) {
          this.logger.warn(
            `flushPageContent failed for ${documentName}: ${err?.['message']}`,
          );
          return { flushed: false };
        }
        return { flushed: true };
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
      // Skips the compare when the document was NOT already resident: no live editors means no unpersisted
      // delta (Hocuspocus refuses to unload while a store is pending), so the caller's row-based check was
      // already authoritative — and a page written through the API stores its content verbatim while this
      // serialization is normalized, so comparing there would 412 forever. Residency is read BEFORE opening
      // the connection, which would otherwise load the document and flip the answer.
      //
      // Returns an outcome and NEVER throws: cross-node, a throwing handler never publishes its RedisSync
      // reply and hangs the caller until the custom-event TTL.
      conditionalUpdatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
          expectedContentHash: string;
        },
      ) => {
        const { prosemirrorJson, operation, user, expectedContentHash } =
          payload;
        const wasResident = hocuspocus.documents.has(documentName);
        let outcome: { applied: boolean; reason?: string } = {
          applied: false,
          reason: 'unknown',
        };
        try {
          await this.withYdocConnection(
            hocuspocus,
            documentName,
            { user },
            (doc) => {
              if (
                wasResident &&
                stableHash(TiptapTransformer.fromYdoc(doc, 'default')) !==
                  expectedContentHash
              ) {
                // No mutation — the immediate store that follows is a no-op, so a refused write cannot
                // even rotate the page's version.
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
      if (fragment.length > 0) {
        fragment.delete(0, fragment.length);
      }

      const newDoc = TiptapTransformer.toYdoc(
        prosemirrorJson,
        'default',
        tiptapExtensions,
      );
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
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
