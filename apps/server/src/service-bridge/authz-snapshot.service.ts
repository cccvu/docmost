import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AuthzChangeEvent } from './authz-change-event';

const MAX_LIMIT = 1000;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** The concerns, in a fixed order. Each is keyset-paginated on its own IMMUTABLE primary id. */
const PHASES = [
  'spaces',
  'space_members',
  'group_users',
  'pages',
  'page_access',
  'page_permissions',
] as const;
type Phase = (typeof PHASES)[number];

export interface SnapshotResult {
  events: AuthzChangeEvent[];
  /** Opaque cursor to pass back for the next page, or null when the whole desired set has been streamed. */
  nextCursor: string | null;
}

/**
 * CCC service-bridge — NOT upstream Docmost code (Group D, issue #171).
 *
 * Streams the FULL desired authorization set (every current membership / page / restriction) as the SAME
 * typed change events the live feed emits (with `seq = 0`, `removed/deleted = false`), so the platform's
 * reconciler reuses ONE event -> SpiceDB-tuple mapping for both the live path and drift repair.
 *
 * RACE-SAFETY: pagination is keyset on each row's IMMUTABLE primary id (NOT a mutable column like
 * updated_at). Combined with the platform pinning its SpiceDB snapshot BEFORE reading this snapshot, a
 * concurrent membership/page/restriction change can never cause a false orphan-DELETE (fail-open): a row
 * present throughout is never skipped by immutable-key keyset; a row added mid-pagination is fresher than the
 * pinned SpiceDB `actual`, so a miss is not an orphan; a row deleted mid-pagination is correctly absent. Worst
 * case the system simply converges on the next reconcile pass. Behavior-preserving: this is a faithful port
 * of the reconciler's six direct SELECTs (single-tenant, non-deleted), which never scoped by workspace.
 *
 * One concern-phase is paged per request; the opaque cursor is `<phaseIndex>.<lastId>`.
 */
@Injectable()
export class AuthzSnapshotService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getSnapshot(rawCursor: string | undefined, limit: number): Promise<SnapshotResult> {
    const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const { phaseIdx, lastId } = this.decode(rawCursor);

    const { events, count, lastRowId } = await this.readPhase(PHASES[phaseIdx], lastId, cappedLimit);

    let nextCursor: string | null;
    if (count === cappedLimit) {
      nextCursor = this.encode(phaseIdx, lastRowId); // more rows in this phase
    } else if (phaseIdx < PHASES.length - 1) {
      nextCursor = this.encode(phaseIdx + 1, ZERO_UUID); // exhausted this phase; start the next
    } else {
      nextCursor = null; // last phase exhausted -> done
    }
    return { events, nextCursor };
  }

  private async readPhase(
    phase: Phase,
    lastId: string,
    limit: number,
  ): Promise<{ events: AuthzChangeEvent[]; count: number; lastRowId: string }> {
    switch (phase) {
      case 'spaces': {
        const res = await sql<{ id: string; workspaceId: string | null }>`
          select id, workspace_id from spaces
          where deleted_at is null and id > ${lastId}
          order by id asc limit ${limit}
        `.execute(this.db);
        return this.pack(res.rows, (r) => ({
          seq: 0,
          type: 'SpaceChanged',
          spaceId: r.id,
          workspaceId: r.workspaceId,
          deleted: false,
        }));
      }
      case 'space_members': {
        const res = await sql<{
          id: string;
          spaceId: string;
          userId: string | null;
          groupId: string | null;
          role: string | null;
        }>`
          select id, space_id, user_id, group_id, role from space_members
          where deleted_at is null and id > ${lastId}
          order by id asc limit ${limit}
        `.execute(this.db);
        return this.pack(res.rows, (r) => ({
          seq: 0,
          type: 'SpaceMemberChanged',
          spaceId: r.spaceId,
          userId: r.userId,
          groupId: r.groupId,
          role: r.role,
          removed: false,
        }));
      }
      case 'group_users': {
        const res = await sql<{ id: string; groupId: string; userId: string }>`
          select id, group_id, user_id from group_users
          where id > ${lastId}
          order by id asc limit ${limit}
        `.execute(this.db);
        return this.pack(res.rows, (r) => ({
          seq: 0,
          type: 'GroupMemberChanged',
          groupId: r.groupId,
          userId: r.userId,
          removed: false,
        }));
      }
      case 'pages': {
        const res = await sql<{ id: string; spaceId: string; parentPageId: string | null }>`
          select id, space_id, parent_page_id from pages
          where deleted_at is null and id > ${lastId}
          order by id asc limit ${limit}
        `.execute(this.db);
        return this.pack(res.rows, (r) => ({
          seq: 0,
          type: 'PageStructureChanged',
          pageId: r.id,
          spaceId: r.spaceId,
          parentPageId: r.parentPageId,
          deleted: false,
        }));
      }
      case 'page_access': {
        const res = await sql<{ id: string; pageId: string }>`
          select id, page_id from page_access
          where id > ${lastId}
          order by id asc limit ${limit}
        `.execute(this.db);
        return this.pack(res.rows, (r) => ({
          seq: 0,
          type: 'PageRestrictionChanged',
          pageId: r.pageId,
          restricted: true,
        }));
      }
      case 'page_permissions': {
        const res = await sql<{
          id: string;
          pageId: string;
          userId: string | null;
          groupId: string | null;
          role: string | null;
        }>`
          select pp.id, pa.page_id, pp.user_id, pp.group_id, pp.role
          from page_permissions pp
          join page_access pa on pa.id = pp.page_access_id
          where pp.id > ${lastId}
          order by pp.id asc limit ${limit}
        `.execute(this.db);
        return this.pack(res.rows, (r) => ({
          seq: 0,
          type: 'PagePermissionChanged',
          pageId: r.pageId,
          userId: r.userId,
          groupId: r.groupId,
          role: r.role,
          removed: false,
        }));
      }
    }
  }

  private pack<T extends { id: string }>(
    rows: T[],
    toEvent: (row: T) => AuthzChangeEvent,
  ): { events: AuthzChangeEvent[]; count: number; lastRowId: string } {
    const events = rows.map(toEvent);
    const lastRowId = rows.length ? rows[rows.length - 1].id : ZERO_UUID;
    return { events, count: rows.length, lastRowId };
  }

  private encode(phaseIdx: number, lastId: string): string {
    return `${phaseIdx}.${lastId}`;
  }

  private decode(raw: string | undefined): { phaseIdx: number; lastId: string } {
    if (!raw) return { phaseIdx: 0, lastId: ZERO_UUID };
    const dot = raw.indexOf('.');
    if (dot <= 0) throw new BadRequestException('invalid snapshot cursor');
    const phaseIdx = Number.parseInt(raw.slice(0, dot), 10);
    const lastId = raw.slice(dot + 1);
    if (!Number.isInteger(phaseIdx) || phaseIdx < 0 || phaseIdx >= PHASES.length) {
      throw new BadRequestException('invalid snapshot cursor phase');
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(lastId)) throw new BadRequestException('invalid snapshot cursor id');
    return { phaseIdx, lastId };
  }
}
