import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { Comment, User, Workspace } from '@docmost/db/types/entity.types';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { WsService } from '../../ws/ws.service';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { ICommentResolvedNotificationJob } from '../../integrations/queue/constants/queue.interface';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { ResolveCommentDto } from './dto';

/**
 * ONE answer for every "that comment is not on that page" case: an unknown, trashed, other-workspace or
 * slug-addressed page, and a comment that is missing, deleted, or belongs to another page. Distinct messages
 * would let a caller who may comment on page A learn whether some comment id exists elsewhere.
 */
const notFound = () => new NotFoundException('comment not found');

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Resolve / reopen a comment thread (#615). Docmost ships the resolve UI and its data model (`resolved_at`,
 * `resolved_by_id`, the `resolveCommentMark` collab event, the resolved notification job) but keeps the server
 * route in its closed EE module, which this build never loads. This is original CCC code over those upstream
 * primitives. The platform relays `PUT /v1/pages/{id}/comments/{commentId}/resolution` here as the acting user;
 * that relay is the caller today. The SPA's resolve button targets the same route, but the SPA hides it behind the
 * `comment:resolution` licence entitlement, which this build never grants.
 *
 * The check order is part of the contract:
 *   1. the page: the id must name the page itself (not a slug), in the caller's workspace, not trashed → 404;
 *   2. `validateCanComment` — the same gate as creating a comment (edit, or view where the space allows viewer
 *      comments) → 403. It runs BEFORE the comment is looked up, so a caller who may not comment learns nothing
 *      about which comment ids exist;
 *   3. the comment must belong to that page and workspace and not be deleted → the SAME 404 as (1);
 *   4. only a thread's first comment carries the resolution → 400 for a reply;
 *   5. already in the requested state → the row, unchanged, with no side effects at all.
 *
 * The write is a compare-and-set on `resolved_at`, so two concurrent requests for the same state cannot both
 * report a transition: the loser returns the winner's row and emits nothing (no second notification, no
 * second audit event). Everything after the write is best-effort. The state change is committed by then, and
 * failing the request would only make the caller retry into the no-op above, which would then never emit the
 * missed events.
 */
@Injectable()
export class CommentResolutionService {
  private readonly logger = new Logger(CommentResolutionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly commentRepo: CommentRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly collaborationGateway: CollaborationGateway,
    private readonly wsService: WsService,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async setResolved(
    dto: ResolveCommentDto,
    user: User,
    workspace: Workspace,
  ): Promise<Comment> {
    const page = await this.pageRepo.findById(dto.pageId);
    // `page.id` must equal the requested id. The DTO already refuses a non-UUID, and this is the belt:
    // `findById` resolves a slug too, and a slug-addressed page must not be treated as the page itself.
    // Lower-cased because Postgres matches a UUID in any case while the row carries the canonical spelling.
    if (
      !page ||
      page.id !== dto.pageId.toLowerCase() ||
      page.workspaceId !== workspace.id ||
      page.deletedAt
    ) {
      throw notFound();
    }

    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    const comment = await this.readComment(dto.commentId);
    if (
      !comment ||
      comment.pageId !== page.id ||
      comment.workspaceId !== workspace.id ||
      comment.deletedAt
    ) {
      throw notFound();
    }
    if (comment.parentCommentId) {
      throw new BadRequestException(
        "only a thread's first comment can be resolved",
      );
    }

    if ((comment.resolvedAt != null) === dto.resolved) return comment;

    const now = new Date();
    const changed = await this.db
      .updateTable('comments')
      .set(
        dto.resolved
          ? { resolvedAt: now, resolvedById: user.id, updatedAt: now }
          : { resolvedAt: null, resolvedById: null, updatedAt: now },
      )
      .where('id', '=', comment.id)
      .where('pageId', '=', page.id)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .where('resolvedAt', dto.resolved ? 'is' : 'is not', null)
      .returning('id')
      .executeTakeFirst();

    if (!changed) {
      // Lost the compare-and-set: a concurrent request already moved it (or the comment was deleted in
      // between). The winner emitted the events; this caller gets the current row and emits nothing.
      const current = await this.readComment(comment.id);
      if (!current || current.pageId !== page.id || current.deletedAt) {
        throw notFound();
      }
      return current;
    }

    // The highlight in the document carries its own `resolved` attribute. Only an inline comment has one; a
    // page-level comment has no mark to update. Same best-effort shape as upstream's `setCommentMark` on
    // create: the comment row is the truth, and a failed mark update leaves only a stale highlight.
    if (comment.type === 'inline') {
      try {
        await this.collaborationGateway.handleYjsEvent(
          'resolveCommentMark',
          `page.${page.id}`,
          { commentId: comment.id, resolved: dto.resolved, user },
        );
      } catch (err) {
        this.logger.warn(
          `Failed to update the comment mark for comment ${comment.id}; the resolution is saved: ${err?.['message']}`,
        );
      }
    }

    // The full row (creator + resolvedBy), which is what the SPA's comment cache swaps in on this event. It is
    // absent only if the comment was deleted right after the write; the transition still happened, so it is
    // still notified and audited below, and the caller is told the comment is gone.
    const updated = await this.readComment(comment.id);

    if (updated) {
      this.wsService
        .emitCommentEvent(page.spaceId, page.id, {
          operation: 'commentResolved',
          pageId: page.id,
          comment: updated,
        })
        .catch((err) =>
          this.logger.warn(
            `Failed to emit commentResolved for comment ${comment.id}: ${err?.['message']}`,
          ),
        );
    }

    // Tell the thread's author, on resolve only; a reopen notifies nobody. The processor owns the rest of the
    // policy (no self-notification, the author must still reach the page). A comment whose author was removed
    // has nobody to tell.
    if (dto.resolved && comment.creatorId) {
      const job: ICommentResolvedNotificationJob = {
        commentId: comment.id,
        commentCreatorId: comment.creatorId,
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: workspace.id,
        actorId: user.id,
      };
      this.notificationQueue
        .add(QueueJob.COMMENT_RESOLVED_NOTIFICATION, job)
        .catch((err) =>
          this.logger.warn(
            `Failed to queue the resolved notification for comment ${comment.id}: ${err?.['message']}`,
          ),
        );
    }

    this.auditService.log({
      event: dto.resolved
        ? AuditEvent.COMMENT_RESOLVED
        : AuditEvent.COMMENT_REOPENED,
      resourceType: AuditResource.COMMENT,
      resourceId: comment.id,
      spaceId: page.spaceId,
      metadata: { pageId: page.id },
    });

    if (!updated) throw notFound();
    return updated;
  }

  private readComment(commentId: string): Promise<Comment | undefined> {
    return this.commentRepo.findById(commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
  }
}
