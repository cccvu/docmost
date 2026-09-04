import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * The fork's own default workspace (oldest, not soft-deleted). A not-yet-bootstrapped fork returns 503
   * (not ready), never a silent wrong workspace.
   */
  async resolveDefaultWorkspaceId(): Promise<string> {
    const ws = await this.db
      .selectFrom('workspaces')
      .select('id')
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!ws) {
      throw new ServiceUnavailableException('no workspace provisioned');
    }
    return ws.id;
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
    const res = await sql<{ workspaceId: string }>`
      select workspace_id from users where id = ${userId}
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('user not found');
    return row.workspaceId;
  }
}
