import {
  afterUnloadDocumentPayload,
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
// upstream persistence hook. The policy/CRDT logic lives in authz/page-write/; this file only calls it.
import { reconcileRowIntoDoc } from '../../authz/page-write/reconcile-store';
import {
  recordStoreFailure,
  clearStoreFailure,
} from '../../authz/page-write/store-failure-registry';
// The alarm tokens (COLLAB_STALE_RECONCILE / COLLAB_STORE_FAILED) are emitted from authz/ — the only fork
// subtree scripts/check-infra-config.mjs §14 scans for a monitoring.tf filter's emitter.
import {
  logStaleReconcile,
  logStoreFailure,
} from '../../authz/page-write/collab-drift-log';

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

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);

    if (!document.isEmpty('default')) {
      return;
    }

    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const doc = new Y.Doc();
      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(doc, dbState);
      return doc;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      Y.encodeStateAsUpdate(ydoc);
      return ydoc;
    }

    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    return new Y.Doc();
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    const { documentName, document, context } = data;

    const pageId = getPageId(documentName);

    // #390: serialization is deferred to INSIDE the row's FOR UPDATE transaction, AFTER the reconcile, so the
    // persisted payload is always a snapshot of `document` taken under the lock — hence a superset of the
    // locked row and never a stale subset that could clobber an out-of-band write. Declared here because the
    // post-write side effects below also read the final values.
    let tiptapJson: any = null;
    let ydocState: Buffer = null;
    let textContent: string = null;

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

        // Serialize AFTER the reconcile, under the lock (see #390 TOCTOU note above).
        tiptapJson = TiptapTransformer.fromYdoc(document, 'default');
        ydocState = Buffer.from(Y.encodeStateAsUpdate(document));
        try {
          textContent = jsonToText(tiptapJson);
        } catch (err) {
          this.logger.warn('jsonToText' + err?.['message']);
        }

        // #390 null-ydoc defensive fallback (dormant: verified no LIVE write path omits ydoc). Without a
        // shared ydoc lineage the CRDT reconcile cannot run, so refuse the exact clobber shape — overwriting
        // a row that has real text with a blank resident doc — while letting a genuine edit proceed.
        if (!page.ydoc) {
          let rowText = '';
          try {
            rowText = jsonToText(page.content as any);
          } catch {
            // treat unparseable row content as non-blank (fail safe: do not overwrite it blindly)
            rowText = ' ';
          }
          if (rowText.trim() !== '' && (textContent ?? '').trim() === '') {
            logStaleReconcile(
              this.logger,
              `refused to overwrite non-empty row content with a blank resident doc (no ydoc lineage): ${pageId}`,
            );
            page = null;
            return;
          }
        }

        if (isDeepStrictEqual(tiptapJson, page.content)) {
          page = null;
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
            lastUpdatedById: context.user.id,
            contributorIds: contributorIds,
          },
          pageId,
          trx,
        );

        this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
      });
      // #390: a completed store (write or no-op) clears any prior failure so the settle stops failing closed.
      clearStoreFailure(document);
    } catch (err) {
      // #390: do NOT re-throw (an unhandled rejection on the setTimeout debounce path could crash the
      // process). Record the failure so the settle (flushPageContent) reports {reason:'error'} → the platform
      // fail-closes the guarded write instead of trusting a version the row never received (ADR 0019). Also
      // drop `page` so the post-store side effects do not fire for a write that rolled back.
      logStoreFailure(this.logger, pageId, err);
      recordStoreFailure(document);
      page = null;
    }

    if (page) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'page.updated',
          updatedAt: new Date().toISOString(),
          lastUpdatedById: context?.user?.id,
          lastUpdatedBy: context?.user
            ? {
                id: context.user?.id,
                name: context.user?.name,
                avatarUrl: context.user?.avatarUrl,
              }
            : undefined,
        }),
      );

      await this.syncTransclusion(pageId, page.workspaceId, tiptapJson);
    }

    if (page) {
      await this.collabHistory.addContributors(pageId, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      if (userMentions.length > 0) {
        await this.notificationQueue.add(QueueJob.PAGE_MENTION_NOTIFICATION, {
          userMentions: userMentions.map((m) => ({
            userId: m.entityId,
            mentionId: m.id,
            creatorId: m.creatorId,
          })),
          oldMentionedUserIds,
          pageId,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
        } as IPageMentionNotificationJob);
      }

      await this.aiQueue.add(QueueJob.PAGE_CONTENT_UPDATED, {
        pageIds: [pageId],
        workspaceId: page.workspaceId,
      });

      await this.enqueuePageHistory(page);
    }
  }

  async onChange(data: onChangePayload) {
    const documentName = data.documentName;
    const userId = data.context?.user?.id;

    if (!userId) return;

    if (!this.contributors.has(documentName)) {
      this.contributors.set(documentName, new Set());
    }

    this.contributors.get(documentName).add(userId);
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
