import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { RawBuilder, sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UpdateWorkspaceSettingsDto } from './dto/workspace-settings.dto';
import { WorkspaceResolver } from './workspace-resolver';

/** The platform-facing workspace settings view (mode normalised: unknown/absent -> null). */
export interface WorkspaceSettingsView {
  name: string | null;
  defaultPageEditMode: 'read' | 'edit' | null;
}

type WorkspaceRow = {
  name: string | null;
  settings: { defaultPageEditMode?: unknown } | null;
};

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Platform-governed workspace name + `defaultPageEditMode`. Docmost gates `POST /api/workspace/update`
 * behind a workspace owner/admin CASL role; platform admins are deliberately non-privileged Docmost
 * members, so the platform used to write `workspaces` directly out-of-process. That write now lives here in
 * the fork (which owns the schema), still gated by the platform's `workspace#administer` decision on the
 * calling side. These fields are not authz-relevant, so there is no SpiceDB outbox to feed. The `settings`
 * JSONB SHALLOW-MERGE mirrors Docmost's own `workspace.repo.ts` write so both producers agree on shape and
 * sibling keys survive.
 */
@Injectable()
export class ServiceWorkspaceService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  private toView(row: WorkspaceRow): WorkspaceSettingsView {
    const mode = row.settings?.defaultPageEditMode;
    return {
      name: row.name,
      defaultPageEditMode: mode === 'read' || mode === 'edit' ? mode : null,
    };
  }

  async getSettings(): Promise<WorkspaceSettingsView> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<WorkspaceRow>`
      select name, settings from workspaces where id = ${workspaceId} and deleted_at is null
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('workspace not found');
    return this.toView(row);
  }

  async updateSettings(dto: UpdateWorkspaceSettingsDto): Promise<WorkspaceSettingsView> {
    // No fields to change: return the current view (and 404 if the workspace is gone).
    if (dto.name === undefined && dto.defaultPageEditMode === undefined) {
      return this.getSettings();
    }
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();

    // Build ONE dynamic UPDATE so name + settings commit atomically and `returning` gives back the new
    // state in a single round-trip. A plain jsonb_build_object assignment would drop sibling settings keys,
    // so defaultPageEditMode is a coalesce + `||` shallow merge (identical to Docmost's own repo write).
    const fragments: RawBuilder<unknown>[] = [];
    if (dto.name !== undefined) fragments.push(sql`name = ${dto.name}`);
    if (dto.defaultPageEditMode !== undefined) {
      fragments.push(
        sql`settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('defaultPageEditMode', ${dto.defaultPageEditMode}::text)`,
      );
    }
    fragments.push(sql`updated_at = now()`);
    const sets = sql.join(fragments, sql`, `);

    const res = await sql<WorkspaceRow>`
      update workspaces set ${sets}
      where id = ${workspaceId} and deleted_at is null
      returning name, settings
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('workspace not found');
    return this.toView(row);
  }
}
