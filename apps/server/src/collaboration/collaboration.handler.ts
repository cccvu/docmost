import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';
import {
  ConditionalUpdateOutcome,
  FlushPageContentOutcome,
} from '../authz/page-write/collab-outcomes';
// #390: the settle must report failure (not a false success) when the store it just ran failed to persist.
import { hasStoreFailure } from '../authz/page-write/store-failure-registry';
// #429: bounded idempotency for keyed content writes — check/record a caller key on the LIVE doc inside the
// same transaction as the mutation (atomic CRDT op). Policy lives in authz/; this is a thin call-out.
import {
  isDuplicateWriteKey,
  recordWriteKey,
  scopedWriteKey,
} from '../authz/page-write/write-idem';
// CCC integration seam (UPSTREAM_MODIFICATIONS.md §2 + authz/route-guard/import-boundary.spec.ts): the conditional
// write compares the LIVE document's digest (cross-service contract code, `stable-hash` beside its shared vectors),
// memoized per document mutation (#716: one walk per state, not one per compare); a content operation's Yjs types are
// built before the connection opens (#716, #731). Pure helpers in authz/; this file only calls them.
import { liveContentDigest } from '../authz/page-write/doc-version';
import {
  insertAsOwnClient,
  PreparedContent,
  prepareContentOperation,
  yieldToEventLoop,
} from '../authz/page-write/replace-update';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  constructor() {}

  getHandlers(hocuspocus: Hocuspocus) {
    return {
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
          // #716: memoized per document state, so a conditional write that follows with no edit in between reuses it.
          return {
            flushed: true,
            contentDigest: liveContentDigest(doc),
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
        // #716: build the operation before opening (a failure opens nothing), then let the loop breathe.
        const prepared = prepareContentOperation(prosemirrorJson, operation);
        await yieldToEventLoop();
        let liveDoc: Document | undefined;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            liveDoc = doc;
            this.applyContentOperation(doc, prepared);
          },
        );
        // #716 R4: the stores that followed the apply (transact's, then disconnect's retry) failed to persist it, and
        // `disconnect()` unloads a document nobody else holds — the write may be lost. Not a 200: the outcome is
        // unknown (500 `write_outcome_unknown`, which the platform answers 504 "may have been applied").
        if (liveDoc && hasStoreFailure(liveDoc)) {
          this.logger.warn(
            `updatePageContent applied to ${documentName} but its store failed; answered write_outcome_unknown`,
          );
          throw new InternalServerErrorException({
            message: 'the content was applied to the live page but could not be confirmed as saved',
            code: 'write_outcome_unknown',
          });
        }
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
          // #429: optional caller idempotency key. When present, a repeat within the retention window is a
          // no-op (`reason:'duplicate'`); recorded on the live doc atomically with the content it applies.
          idempotencyKey?: string;
          // #716: the page is at the API size cap (the caller measured it): refuse the append/prepend with
          // `too_large`, but only AFTER the dedup and the CAS, so a retry of an append that already applied still
          // answers `duplicate` (a 200), never a false "not applied".
          refuseOverCap?: boolean;
        },
      ): Promise<ConditionalUpdateOutcome> => {
        const {
          prosemirrorJson,
          operation,
          user,
          expectedContentHash,
          idempotencyKey,
          refuseOverCap,
        } = payload;
        let outcome: ConditionalUpdateOutcome = {
          applied: false,
          reason: 'unknown',
        };
        // #716 O2/R4: set right before the first mutation. A throw after it, or a failed store after the apply,
        // is `applied_unconfirmed` (the live document holds the write, the row may not), never a retryable error.
        let mutationStarted = false;
        let liveDoc: Document | undefined;
        try {
          // #716: a content operation is built FIRST — a pure function of the request, so building it here
          // changes no concurrency semantics — and the loop gets a tick before the pre-check. A build failure opens
          // no connection and runs no store (#342 BUILD-BEFORE-DELETE, strengthened). Nothing yields between the
          // pre-check and the transaction: that would widen the #282 window described below.
          // #716 page cap on a RESIDENT document: decided on it directly, in the same order as inside the transaction
          // below (dedup, then CAS, then the cap), without opening a connection — whose two stores would walk the
          // whole (over-cap) page and could persist a human's unsaved edit under this caller. A refusal touches
          // nothing. Not resident: the connection below loads it (no unsaved edit exists to reattribute).
          const resident0 = refuseOverCap
            ? hocuspocus.documents.get(documentName)
            : undefined;
          if (resident0) {
            if (
              idempotencyKey &&
              isDuplicateWriteKey(
                resident0,
                scopedWriteKey(user.id, idempotencyKey),
              )
            ) {
              return { applied: false, reason: 'duplicate' };
            }
            if (
              expectedContentHash &&
              liveContentDigest(resident0) !== expectedContentHash
            ) {
              return { applied: false, reason: 'precondition' };
            }
            return { applied: false, reason: 'too_large' };
          }
          // A refused-over-cap write builds nothing (its content is never applied, and may not have been parsed).
          let prepared: PreparedContent | undefined;
          if (!refuseOverCap) {
            prepared = prepareContentOperation(prosemirrorJson, operation);
            await yieldToEventLoop();
          }
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
          // #716: memoized per document state, so the compare inside the transaction below reuses this digest
          // unless a transaction (any edit, delete-only or remote included) ran in between.
          if (resident && liveContentDigest(resident) !== expectedContentHash) {
            return { applied: false, reason: 'precondition' };
          }
          await this.withYdocConnection(
            hocuspocus,
            documentName,
            { user },
            (doc) => {
              // #429: the dedup key is NAMESPACED by the acting user (scopedWriteKey). The key is
              // caller-chosen and the ledger is per-page, so an unscoped key would let one user's write
              // suppress another user's genuine write as a false "duplicate" — a cross-user lost update
              // (security review S1). Same-identity retries still dedup.
              const writeKey = idempotencyKey
                ? scopedWriteKey(user.id, idempotencyKey)
                : undefined;
              // Idempotency dedup FIRST — a retry of an already-applied keyed write is a no-op success
              // regardless of the CAS (the KEY, not the version, is the retry's identity; a version compare
              // would 412 the retry of a write whose own apply moved the content). PURE read: on a duplicate
              // we return WITHOUT mutating, so the closing `disconnect()` store finds unchanged content and
              // hits persistence.extension's `isDeepStrictEqual` no-op skip. (The #282 residual still holds:
              // if a human's unpersisted edit is racing this connection, that closing store persists THEIR
              // edit under the caller — no keyed content is double-applied, which is what this guards.)
              if (writeKey && isDuplicateWriteKey(doc, writeKey)) {
                outcome = { applied: false, reason: 'duplicate' };
                return;
              }
              // The authoritative compare: inside the transaction, so an edit cannot land between it and
              // the mutation. The pre-check above is an optimization, not a substitute — it cannot see an
              // edit that arrives while the connection is opening.
              if (
                expectedContentHash &&
                liveContentDigest(doc) !== expectedContentHash
              ) {
                outcome = { applied: false, reason: 'precondition' };
                return;
              }
              // #716: the page cap, after the dedup and the CAS (see `refuseOverCap`), before any mutation.
              if (refuseOverCap) {
                outcome = { applied: false, reason: 'too_large' };
                return;
              }
              liveDoc = doc;
              mutationStarted = true;
              this.applyContentOperation(doc, prepared);
              // #429: record the key in the SAME transaction as the content it applies — one atomic CRDT
              // mutation, so the key rides the persisted ydoc with the append (both commit or neither).
              // ONLY on an actual apply, and AFTER the CAS above: a write that FAILED the precondition must
              // not record its key, or the caller's corrected retry would be silently swallowed as a
              // duplicate (a lost update). A content-neutral write is dropped by the deep-equal skip and has
              // nothing to dedup anyway.
              if (writeKey) recordWriteKey(doc, writeKey, Date.now());
              outcome = { applied: true };
            },
          );
        } catch (err) {
          this.logger.warn(
            `conditionalUpdatePageContent failed for ${documentName}${mutationStarted ? ' after it began applying' : ''}: ${err?.['message']}`,
          );
          // #716 O2: once the mutation began, the live document holds (some of) this write and a later store may
          // persist it: answering a retryable error would invite a second append. Unknown outcome, said so.
          return mutationStarted
            ? { applied: false, reason: 'applied_unconfirmed' }
            : { applied: false, reason: 'error' };
        }
        // #716 R4: applied, but the stores that followed (transact's and disconnect's, the in-request retry) failed
        // to persist it. The append lives only in the resident document, and `disconnect()` unloads a document
        // nobody else holds — so this is not a 200.
        if (outcome.applied && liveDoc && hasStoreFailure(liveDoc)) {
          this.logger.warn(
            `conditionalUpdatePageContent applied to ${documentName} but its store failed; answered applied_unconfirmed`,
          );
          return { applied: false, reason: 'applied_unconfirmed' };
        }
        return outcome;
      },
    };
  }

  /**
   * Apply a content operation to a live document. Extracted verbatim from `updatePageContent` so the
   * conditional write (#282) applies byte-identical semantics — there must be exactly one definition of
   * what `replace`/`append`/`prepend` mean. #716: the operation is built beforehand by `prepareContentOperation`
   * (authz/page-write/replace-update.ts), so only the mutation itself runs here, inside the transaction.
   */
  private applyContentOperation(
    doc: Document,
    prepared: PreparedContent,
  ): void {
    const fragment = doc.getXmlFragment('default');

    if (prepared.kind === 'replace') {
      // BUILD BEFORE DELETE (#342). `TiptapTransformer.toYdoc` throws on content it cannot convert
      // (a body that passed `jsonToNode` but that the Yjs transformer rejects). If the fragment were
      // emptied first, that throw would leave an empty document behind, and the connection's closing
      // `disconnect()` store would persist it — silently WIPING the page while the request also fails.
      // Encoding the new state first means a conversion failure aborts before any mutation, so the
      // original content survives and the closing store re-persists it unchanged.
      // (#716/#731: `prepared.elements` were built before the connection opened — the build-before-delete order holds.)
      if (fragment.length > 0) {
        fragment.delete(0, fragment.length);
      }
      insertAsOwnClient(doc, fragment, prepared.elements); // #731: as the toYdoc build did, a client id per replace
    } else {
      const position = prepared.atStart ? 0 : fragment.length;
      fragment.insert(position, prepared.elements);
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
      // #716: ONE Yjs transaction around the whole callback (Hocuspocus's DirectConnection.transact does not open
      // one). A nested `applyUpdate` joins it, so a replace's delete + apply — and #429's key record — are one
      // atomic CRDT mutation: one update event, one broadcast, and peers never see the empty fragment between them.
      await connection.transact((doc) => doc.transact(() => fn(doc)));
    } finally {
      await connection.disconnect();
    }
  }
}
