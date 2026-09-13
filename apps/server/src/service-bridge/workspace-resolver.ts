import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The single source of truth for "which workspace" in the east-west surface. The deployment is
 * single-tenant, so the CANONICAL workspace is the oldest non-soft-deleted one; every service-bridge
 * endpoint resolves it here rather than accepting a caller-supplied Docmost workspace id. Centralising it
 * (instead of each service re-querying) is what makes the single-tenant invariant testable in one place:
 * the platform, after Phase C, stops resolving the canonical workspace itself and consumes
 * `GET /api/service/workspace/default`, so this method is the ONLY definition of "canonical workspace".
 */
@Injectable()
export class WorkspaceResolver {
  private readonly logger = new Logger(WorkspaceResolver.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * The fork's own default workspace (oldest, not soft-deleted). A not-yet-bootstrapped fork returns 503
   * (not ready), never a silent wrong workspace.
   *
   * Companion F4: the pick is DETERMINISTIC — oldest `createdAt`, then lowest `id` as a tiebreak — so two
   * workspaces created in the same instant can't flip "the canonical workspace" between calls. And it is
   * OBSERVABLE — if more than one non-deleted workspace exists (the single-tenant invariant this whole
   * module rests on is breached), it WARNs rather than silently misrouting every service-bridge op. It does
   * NOT hard-fail on >1: that would turn an accidental second workspace into a total east-west outage; the
   * warn surfaces the anomaly to ops while the deterministic pick keeps the system serving.
   */
  async resolveDefaultWorkspaceId(): Promise<string> {
    const rows = await this.db
      .selectFrom('workspaces')
      .select('id')
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(2)
      .execute();
    if (rows.length === 0) {
      throw new ServiceUnavailableException('no workspace provisioned');
    }
    if (rows.length > 1) {
      this.logger.warn(
        'more than one non-deleted workspace exists — the single-tenant invariant is breached; ' +
          'resolving the oldest deterministically. Investigate the extra workspace(s).',
      );
    }
    return rows[0].id;
  }

  /**
   * The workspace a specific Docmost user belongs to (existence check + workspace lookup). Read-only and
   * bounded; 404 if the user id does not exist. Used by the platform to reverse-provision a PDP anchor for a
   * Docmost-native user it has no mapping for. Raw SQL keeps it a single indexed PK read.
   */
  async resolveUserWorkspaceId(userId: string): Promise<string> {
    // NOTE: the fork's Kysely runs CamelCasePlugin, which camelCases result keys even for raw `sql` — so a
    // `select workspace_id` column comes back as `workspaceId` (not `workspace_id`). Every raw-sql read in
    // this module reads camelCase result keys for that reason.
    // Companion F5: exclude soft-deleted users (a deleted user must not anchor a PDP grant), and reject a
    // null `workspace_id` (the column is nullable) rather than returning `null` typed as `string` — a bogus
    // anchor is worse than a clean 404.
    const res = await sql<{ workspaceId: string | null }>`
      select workspace_id from users where id = ${userId} and deleted_at is null
    `.execute(this.db);
    const row = res.rows[0];
    if (!row || !row.workspaceId) throw new NotFoundException('user not found');
    return row.workspaceId;
  }
}
