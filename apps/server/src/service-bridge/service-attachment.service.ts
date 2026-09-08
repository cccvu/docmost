import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceResolver } from './workspace-resolver';
import { SubCollectionPage } from './dto/sub-collection-page.dto';
import { AttachmentType } from '../core/attachment/attachment.constants';

/** Compact, PII-free attachment shape for `/v1` list responses (ISO timestamps over the wire). */
export interface PublicAttachmentSummary {
  id: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  type: string | null;
  createdAt: string;
}

// CamelCasePlugin: raw-sql result keys come back camelCased (file_name -> fileName, ...). fileSize is int8,
// which the pg driver returns as a string; coerced to number in the mapper (file sizes stay < 2^53).
interface AttachmentRow {
  id: string;
  fileName: string;
  mimeType: string | null;
  fileSize: string | number | null;
  type: string | null;
  createdAt: Date;
}

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Read-only attachment lookups the platform's `/v1` attachment surface needs. Deliberately NOT backed by the
 * upstream AttachmentRepo (adding a method there is an upstream-owned-file edit); it reads the `attachments`
 * table with raw `sql`, exactly as ServiceContentService reads pages/spaces — so all of this stays inside the
 * CCC service-bridge subtree (no UPSTREAM_MODIFICATIONS entry, no boundary-check divergence).
 *
 * Authorization is Option A (resolve→page): the platform maps attachment→page via `resolvePage` and checks
 * page#view/#edit itself (the schema already gives attachment inherit-from-page). This is a privileged data
 * plane, NOT a gate — it returns metadata for the addressed attachment/page without re-authorizing.
 */
@Injectable()
export class ServiceAttachmentService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /**
   * Resolve an attachment to its owning page + space (workspace-scoped, active only). `pageId`/`spaceId` are
   * null for non-page attachments (avatars, workspace/space icons, chat uploads), so the platform denies them
   * (no page to authorize view against). Unknown / cross-workspace / deleted → 404.
   */
  async resolvePage(
    attachmentId: string,
  ): Promise<{ attachmentId: string; pageId: string | null; spaceId: string | null }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<{ pageId: string | null; spaceId: string | null }>`
      select page_id, space_id from attachments
      where id = ${attachmentId} and workspace_id = ${workspaceId} and deleted_at is null
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('attachment not found');
    return { attachmentId, pageId: row.pageId ?? null, spaceId: row.spaceId ?? null };
  }

  /**
   * The file attachments on a page (compact projection). `type = 'file'` excludes avatars/icons/chat uploads
   * (only file-type rows carry a pageId anyway); workspace-scoped and soft-delete-excluded. Ordered oldest
   * first with an id tiebreak for a stable list. The platform authorizes page#view BEFORE calling.
   *
   * Opt-in keyset paging (the same contract as space members / page ACL — see SubCollectionPage): with
   * `page.limit` the fork walks `(created_at, id)` ascending and returns up to limit+1 (so the platform can
   * detect hasMore + build the next cursor from the last kept row); without it the read is unpaged (all file
   * attachments). This gives a heavily-attached page a bounded read instead of an unbounded array, and keeps
   * attachments consistent with the other sub-collection reads. The default (unpaged) shape is unchanged.
   */
  async listByPage(
    pageId: string,
    page?: SubCollectionPage,
  ): Promise<{ items: PublicAttachmentSummary[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const paged = page?.limit !== undefined;
    const conds = [
      sql`page_id = ${pageId}`,
      sql`workspace_id = ${workspaceId}`,
      sql`type = ${AttachmentType.File}`,
      sql`deleted_at is null`,
    ];
    if (paged && page!.before) {
      conds.push(
        sql`(date_trunc('milliseconds', created_at), id::text) > (${page!.before.createdAt}::timestamptz, ${page!.before.id}::text)`,
      );
    }
    const order = paged
      ? sql`order by date_trunc('milliseconds', created_at) asc, id::text asc`
      : sql`order by created_at asc, id::text asc`;
    const limitClause = paged ? sql`limit ${page!.limit! + 1}` : sql``;
    const res = await sql<AttachmentRow>`
      select id, file_name, mime_type, file_size, type, created_at
      from attachments
      where ${sql.join(conds, sql` and `)}
      ${order}
      ${limitClause}
    `.execute(this.db);
    return { items: res.rows.map(toAttachmentSummary) };
  }
}

function toAttachmentSummary(r: AttachmentRow): PublicAttachmentSummary {
  return {
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mimeType,
    fileSize: r.fileSize == null ? null : Number(r.fileSize),
    type: r.type,
    createdAt: iso(r.createdAt),
  };
}
