import {
  afterUnloadDocumentPayload,
  beforeUnloadDocumentPayload,
  Extension,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getPageId, jsonToText, tiptapExtensions } from '../collaboration.util';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import {
  extractMentions,
  extractUserMentions,
} from '../../common/helpers/prosemirror/utils';
import { isDeepStrictEqual } from 'node:util';
import {
  IPageHistoryJob,
  IPageMentionNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { Page } from '@docmost/db/types/entity.types';
import { CollabHistoryService } from '../services/collab-history.service';
import {
  HISTORY_FAST_INTERVAL,
  HISTORY_FAST_THRESHOLD,
  HISTORY_INTERVAL,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
// CCC integration seam (UPSTREAM_MODIFICATIONS.md + authz/route-guard/import-boundary.spec.ts): #390 folds
// the fork-owned symmetric stale-doc guard (reconcile-before-store) and the store-failure signal into the
// upstream persistence hook; #731 adds the one-store-per-write skip and the reconcile memo. The policy/CRDT
// logic lives in authz/page-write/; this file only calls it.
import {
  markRowCovered,
  reconcileRowIntoDoc,
} from '../../authz/page-write/reconcile-store';
import { shouldRefuseBlankClobber } from '../../authz/page-write/blank-clobber-guard';
import {
  recordStoreFailure,
  clearStoreFailure,
  isStoreCurrent,
  markStoredAt,
} from '../../authz/page-write/store-failure-registry';
// The alarm tokens (COLLAB_STALE_RECONCILE / COLLAB_STORE_FAILED / COLLAB_POST_STORE_FAILED) are emitted from
// authz/ — the CCC-owned fork subtree scripts/check-infra-config.mjs §14 scans for a monitoring.tf filter's
// emitter (and it keeps the alarm-token policy out of this upstream-owned file).
import {
  logStaleReconcile,
  logStoreFailure,
  logPostStoreFailure,
} from '../../authz/page-write/collab-drift-log';
// #731: the load reads `content` only for a legacy row; the store yields a loop turn between its page-sized steps.
// CCC #773: the store's snapshot (persistence-steps) makes the stored projection storable (no lone surrogate or NUL).
import {
  findPageRowForLoad,
  snapshotForStore,
} from '../../authz/page-write/persistence-steps';
import { yieldToEventLoop } from '../../authz/page-write/yield-to-event-loop';
// CCC #827: the bounded load (a page too costly to load answers try-later and is compacted from its row), compaction at
// unload, and no store for a document a compaction superseded. The policy lives in authz/page-write/compaction.
import {
  compactOnUnload,
  skipStoreOfSuperseded,
} from '../../authz/page-write/compaction';
// CCC #840: serve and store only reload-stable states (an unstable store carries a verified heal image, the load heals
// from it), hand the guard's replica log the exact bytes each load applied, and install the heal table at boot.
import {
  afterOrderStore,
  checkStoreOrder,
  loadStableYdoc,
  noteLoadedBytes,
  persistOrderState,
  type OrderStoreOutcome,
} from '../../authz/page-write/heal-image';
import { installHealImageTableAtBoot } from '../../authz/page-write/heal-image.installer';

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors: Map<string, Set<string>> = new Map();

  constructor(
    private readonly pageRepo: PageRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
  ) {}

  // CCC #840 (UPSTREAM_MODIFICATIONS.md #122): the heal-image table, in every process that runs this extension (the app
  // and collab-main) and every mode; a boot that cannot install it fails.
  async onApplicationBootstrap() {
    await installHealImageTableAtBoot(this.db);
  }

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);
    // CCC #731 (UPSTREAM_MODIFICATIONS.md #122): type the root fragment now, while nothing observes the document. A
    // fragment first typed by a later read (the store's or the digest's `fromYdoc`) is typed inside a transaction,
    // which looks like an edit to the generation those memos are keyed on (authz/page-write/doc-version.ts).
    document.getXmlFragment('default');

    if (!document.isEmpty('default')) {
      return;
    }

    // CCC #731 (UPSTREAM_MODIFICATIONS.md #122): `content` is read only for a row with no ydoc, the one branch that
    // uses it (a page-sized jsonb parse and key walk otherwise thrown away).
    const page = await findPageRowForLoad(
      (id, opts) => this.pageRepo.findById(id, opts),
      pageId,
    );

    if (!page) {
      this.logger.warn('page not found');
      noteLoadedBytes(document, Y.encodeStateAsUpdate(document)); // CCC #840
      return;
    }

    // CCC #731 (UPSTREAM_MODIFICATIONS.md #122): fill Hocuspocus's own `document` and return nothing. A returned
    // doc other than `document` is re-encoded and re-applied by Hocuspocus (one more page-sized encode + apply per
    // load); a hook that returns nothing skips that step, and nothing is listening to the document yet.
    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const dbState = new Uint8Array(page.ydoc);

      // CCC #827 (UPSTREAM_MODIFICATIONS.md #122): the apply, bounded (a walk-step budget and a deadline). A trip throws
      // the compacting refusal (Hocuspocus then destroys this document) and compacts the page from its row. Also
      // records the bytes as covered (#731). #840: only a reload-stable state is served (a heal image adopted, or
      // try-later); the exact bytes applied go to the guard's replica log.
      await loadStableYdoc(document, pageId, dbState, this.db);
      return;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      const update = Y.encodeStateAsUpdate(ydoc);
      Y.applyUpdate(document, update);
      noteLoadedBytes(document, update); // CCC #840
      return;
    }

    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    noteLoadedBytes(document, Y.encodeStateAsUpdate(document)); // CCC #840
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    const { documentName, document, lastContext } = data;

    // CCC #731: nothing ran on the document since its last successful store (a content write's `disconnect()`
    // store after the store that follows its transaction) — nothing to persist. Before consuming the contributors,
    // which stay for the next real store. Never throws.
    if (isStoreCurrent(document)) return;
    // CCC #827: a document a compaction superseded never stores (its row moved to a new lineage); recorded as a failure.
    if (skipStoreOfSuperseded(document)) return;

    const pageId = getPageId(documentName);

    // #390: serialization is deferred to INSIDE the row's FOR UPDATE transaction, AFTER the reconcile, so the
    // persisted payload is always a snapshot of `document` taken under the lock — hence a superset of the
    // locked row and never a stale subset that could clobber an out-of-band write. Declared here because the
    // post-write side effects below also read the final values.
    let tiptapJson: any = null;
    let ydocState: Buffer = null;
    let textContent: string = null;
    // #731: the document generation this store's serialization covers, and what the store did with it.
    let coveredGeneration: number | undefined;
    let stored: 'written' | 'unchanged' | undefined;
    let orderStored: OrderStoreOutcome | undefined; // CCC #840

    let page: Page = null;
    const editingUserIds = this.consumeContributors(documentName);

    try {
      await executeTx(this.db, async (trx) => {
        page = await this.pageRepo.findById(pageId, {
          withLock: true,
          includeContent: true,
          includeYdoc: true, // #390: the row's ydoc for the reconcile diff, read under the SAME lock
          trx,
        });

        if (!page) {
          this.logger.error(`Page with id ${pageId} not found`);
          return;
        }

        // CCC #731: a loop turn between the locked read and the reconcile, between the snapshot and `jsonToText`, and
        // after `jsonToText` (three page-sized blocks, not one). Never inside the snapshot (`snapshotForStore`).
        await yieldToEventLoop();

        // #390 — SYMMETRIC guard. Fold any row content this resident doc is MISSING back in (lossless Yjs
        // union) BEFORE serializing, so a stale resident copy cannot revert an out-of-band write. No-op in
        // normal operation (the resident is a superset of the row). Runs inside the lock; the merge also
        // updates the in-memory doc, so connected editors converge too.
        if (page.ydoc) {
          const { merged } = reconcileRowIntoDoc(document, page.ydoc);
          if (merged) {
            logStaleReconcile(
              this.logger,
              `folded out-of-band row content into the resident doc before store: ${pageId}`,
            );
          }
        }

        // Serialize AFTER the reconcile, under the lock (see #390 TOCTOU note above). #731: the generation, `fromYdoc`
        // and the encode are ONE synchronous run (an edit in a later yield bumps the generation: the next store runs).
        const snapshot = snapshotForStore(document);
        // CCC #840: in the same synchronous run, whether exactly these bytes reload into live's order.
        const order = checkStoreOrder(document, snapshot);
        coveredGeneration = snapshot.generation;
        tiptapJson = snapshot.json;
        ydocState = snapshot.state;
        await yieldToEventLoop();
        try {
          textContent = jsonToText(tiptapJson);
        } catch (err) {
          this.logger.warn('jsonToText' + err?.['message']);
        }
        await yieldToEventLoop();

        // #390 null-ydoc defensive fallback (dormant: verified no LIVE write path omits ydoc). Without a
        // shared ydoc lineage the CRDT reconcile cannot run, so refuse the clobber shape — a blank resident
        // doc overwriting a row that still holds real content — via the pure structural guard, while letting
        // a genuine edit proceed. A non-blank-over-non-blank clobber is NOT defensible here without lineage;
        // that residual is why the dormancy claim (all live writers co-write ydoc) is load-bearing (#390).
        if (!page.ydoc && shouldRefuseBlankClobber(page.content, tiptapJson)) {
          logStaleReconcile(
            this.logger,
            `refused to overwrite non-empty row content with a blank resident doc (no ydoc lineage): ${pageId}`,
          );
          page = null;
          return;
        }

        // CCC #840: stable drops any heal row; unstable writes the verified heal image beside the raw bytes (also when the
        // content is unchanged), in this transaction.
        const unchanged = isDeepStrictEqual(tiptapJson, page.content);
        orderStored = await persistOrderState(this.db, trx, pageId, snapshot, order, unchanged);
        if (unchanged) {
          page = null;
          stored = 'unchanged';
          return;
        }

        let contributorIds = undefined;
        try {
          const existingContributors = page.contributorIds || [];
          contributorIds = Array.from(
            new Set([
              ...existingContributors,
              ...editingUserIds,
              page.creatorId,
            ]),
          );
        } catch (err) {
          //this.logger.debug('Contributors error:' + err?.['message']);
        }

        await this.pageRepo.updatePage(
          {
            content: tiptapJson,
            textContent: textContent,
            ydoc: ydocState,
            lastUpdatedById: lastContext.user.id,
            contributorIds: contributorIds,
          },
          pageId,
          trx,
        );

        stored = 'written';
        this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
      });
      // #390: a completed store (write or no-op) clears any prior failure so the settle stops failing closed.
      clearStoreFailure(document);
      // #731: committed — the next store may skip while the generation is unchanged (not after a not-found or a
      // refused blank clobber); a written row is bytes this document covers.
      markStoredAt(document, stored ? coveredGeneration : undefined);
      if (stored === 'written' || orderStored?.ydocWritten) markRowCovered(document, ydocState);
      afterOrderStore(document, pageId, orderStored); // CCC #840: compaction requested for an unstable store; never throws
    } catch (err) {
      // #390: do NOT re-throw (an unhandled rejection on the setTimeout debounce path could crash the
      // process). Record the failure so the settle (flushPageContent) reports {reason:'error'} → the platform
      // fail-closes the guarded write instead of trusting a version the row never received (ADR 0019). Also
      // drop `page` so the post-store side effects do not fire for a write that rolled back.
      logStoreFailure(this.logger, pageId, err);
      recordStoreFailure(document);
      page = null;
    }

    // #345: EVERYTHING below runs AFTER the row has committed. A throw here must NEVER reject onStoreDocument.
    // Hocuspocus re-throws hook errors and its debouncer leaves the rejected store resident in
    // `runningExecutions`, so a single post-commit blip (a Redis/BullMQ enqueue, the contributors DB write, a
    // broadcast to a dead socket) would permanently wedge persistence for THIS document until process restart
    // — every later edit silently lost — and on the settle/flush path (`flushPageContent` → `executeNow`)
    // return a false 503 for a write that actually committed. Each side effect is best-effort and independent,
    // so it is isolated: a failure is logged and never propagates, and one failing effect never skips the rest.
    if (page) {
      const persisted = page;

      // #345: an outer backstop so the "onStoreDocument never rejects post-commit" invariant is STRUCTURAL,
      // not merely per-callsite. Each effect below is already individually isolated (so one failure never
      // skips the rest), but this guard also catches a throw from `syncTransclusion`'s own handler or from any
      // FUTURE unwrapped await added to this block — the exact regression that would silently re-poison the
      // debouncer. The row is already committed, so swallowing here can only lose a derived-data effect, never
      // content; the failure is logged + alarmed via COLLAB_POST_STORE_FAILED.
      try {
        // #345/#429: the post-commit side effects are best-effort, INDEPENDENT (none reads another's
        // output), and each `runPostStoreSideEffect` swallows its own errors — so run them CONCURRENTLY.
        // `Promise.allSettled` never rejects and the wrappers never reject, so the row's commit is never at
        // risk; the outer try remains a structural backstop for any FUTURE unwrapped await. Concurrency
        // shrinks `onStoreDocument`'s tail latency on the settle→write path — the same path #429's
        // content-write timeout bounds — so a slow store is less likely to trip a false 504 (and the retry
        // it invites). `syncTransclusion` self-isolates internally, but is wrapped here too so every effect
        // is uniformly isolated and the never-reject invariant is structural, not per-callsite.
        await Promise.allSettled([
          this.runPostStoreSideEffect('broadcast', pageId, () =>
            document.broadcastStateless(
              JSON.stringify({
                type: 'page.updated',
                updatedAt: new Date().toISOString(),
                lastUpdatedById: lastContext?.user?.id,
                lastUpdatedBy: lastContext?.user
                  ? {
                      id: lastContext.user?.id,
                      name: lastContext.user?.name,
                      avatarUrl: lastContext.user?.avatarUrl,
                    }
                  : undefined,
              }),
            ),
          ),

          this.runPostStoreSideEffect('transclusion', pageId, () =>
            this.syncTransclusion(pageId, persisted.workspaceId, tiptapJson),
          ),

          this.runPostStoreSideEffect('contributors', pageId, () =>
            this.collabHistory.addContributors(pageId, editingUserIds),
          ),

          this.runPostStoreSideEffect(
            'mention-notification',
            pageId,
            async () => {
              const mentions = extractMentions(tiptapJson);
              const userMentions = extractUserMentions(mentions);
              if (userMentions.length === 0) return;
              const oldMentions = persisted.content
                ? extractMentions(persisted.content)
                : [];
              const oldMentionedUserIds = extractUserMentions(oldMentions).map(
                (m) => m.entityId,
              );
              await this.notificationQueue.add(
                QueueJob.PAGE_MENTION_NOTIFICATION,
                {
                  userMentions: userMentions.map((m) => ({
                    userId: m.entityId,
                    mentionId: m.id,
                    creatorId: m.creatorId,
                  })),
                  oldMentionedUserIds,
                  pageId,
                  spaceId: persisted.spaceId,
                  workspaceId: persisted.workspaceId,
                } as IPageMentionNotificationJob,
              );
            },
          ),

          this.runPostStoreSideEffect('ai-queue', pageId, () =>
            this.aiQueue.add(QueueJob.PAGE_CONTENT_UPDATED, {
              pageIds: [pageId],
              workspaceId: persisted.workspaceId,
            }),
          ),

          this.runPostStoreSideEffect('history', pageId, () =>
            this.enqueuePageHistory(persisted),
          ),
        ]);
      } catch (err) {
        // The per-effect wrappers never throw and allSettled never rejects, so reaching here would require a
        // FUTURE unwrapped post-commit await added outside the array. Content is already durable; never
        // re-throw (a rejected onStoreDocument poisons Hocuspocus's debouncer — #345).
        logPostStoreFailure(this.logger, 'post-store-block', pageId, err);
      }
    }
  }

  /**
   * Run a best-effort POST-STORE side effect in isolation (#345). These run after the row has committed, so a
   * throw must never reject `onStoreDocument`: Hocuspocus's debouncer would otherwise leave the rejected store
   * resident and wedge all future persistence for this document until restart. Mirrors the isolation
   * `syncTransclusion` already applies to its own calls. Never re-throws; the page content is already durable.
   */
  private async runPostStoreSideEffect(
    label: string,
    pageId: string,
    fn: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // #345: emit the alarm token (COLLAB_POST_STORE_FAILED, via the fork's authz/ tree) instead of a plain
      // error, so a systematic post-store failure is surfaced by CloudWatch (monitoring.tf) rather than only
      // logged. Never re-throws — a rejected onStoreDocument would poison Hocuspocus's debouncer.
      logPostStoreFailure(this.logger, label, pageId, err);
    }
  }

  async onChange(data: onChangePayload) {
    const documentName = data.documentName;
    // CCC #790 (UPSTREAM_MODIFICATIONS.md #122): only a websocket editor is a contributor, as under Hocuspocus 3.4.4.
    // 4.x also hands a direct connection's context to onChange (its `transact` origin carries it), which would make
    // every /v1, MCP and comment-mark writer a contributor.
    if ((data.transactionOrigin as { source?: unknown } | null)?.source !== 'connection') return;
    const userId = data.context?.user?.id;

    if (!userId) return;

    if (!this.contributors.has(documentName)) {
      this.contributors.set(documentName, new Set());
    }

    this.contributors.get(documentName).add(userId);
  }

  // CCC #827 (UPSTREAM_MODIFICATIONS.md #122): compact a document that asked for it, now that nothing holds it (the
  // document is still resident and RedisSync still holds its lock). Never throws: a throw would keep it resident.
  async beforeUnloadDocument(data: beforeUnloadDocumentPayload) {
    await compactOnUnload(data.document, this.db);
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
  }

  private consumeContributors(documentName: string): string[] {
    const contributorSet = this.contributors.get(documentName);
    if (!contributorSet) return [];
    const userIds = [...contributorSet];
    this.contributors.delete(documentName);
    return userIds;
  }

  private async enqueuePageHistory(page: Page): Promise<void> {
    const pageAge = Date.now() - new Date(page.createdAt).getTime();
    const delay =
      pageAge < HISTORY_FAST_THRESHOLD
        ? HISTORY_FAST_INTERVAL
        : HISTORY_INTERVAL;

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id } as IPageHistoryJob,
      { jobId: page.id, delay },
    );
  }

  /**
   * Refresh `page_transclusions` and `page_transclusion_references` to match
   * the page's current content. Runs outside the page-write transaction and
   * isolates each call so a failure here cannot affect the page save itself.
   * The diff is idempotent — the next save converges if a round drops anything.
   */
  private async syncTransclusion(
    pageId: string,
    workspaceId: string,
    tiptapJson: unknown,
  ): Promise<void> {
    try {
      await this.transclusionService.syncPageTransclusions(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusions for page',
      );
    }
    try {
      await this.transclusionService.syncPageReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusion references for page',
      );
    }
  }
}
