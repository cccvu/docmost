import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { HttpAuthzClient, AuthzCheckItem, AuthzSubject } from '../authz/http-authz.client';
import { purgeSettleWaitMs, settle } from '../authz/page-delete/page-delete-decision';
import { authzUnavailable } from '../authz/authz-unavailable';
import { refusal } from './resource-version';
import { SPACE_ROLES, SpaceMemberRole } from './dto/space-admin.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #797, INV-2).
 *
 * "Never grant more than you hold" for space memberships. A member write that RAISES a membership (an add, a
 * re-add of a soft-deleted row, a role change upward — user or group subject alike) must be covered by what the
 * ACTING HUMAN holds on that space:
 *
 *   reader ⇐ the actor has `space#view`
 *   writer ⇐ the actor has `space#edit` AND `space#share`
 *   admin  ⇐ the actor holds a live DIRECT admin membership (their own row, or a row of a group they are in), OR
 *            `workspace#admin_cascade` (a workspace admin, who really is admin of every live space)
 *
 * Refusal: `403 grant_exceeds_actor`, nothing written. A write that does not raise (a demotion, a same-role re-add,
 * an `atLeast` add that changes nothing) grants nothing new and is not checked; removal stays open.
 *
 * How it decides — local rows first, the PDP only for the remainder and only after a settle fence:
 *  1. Inside the write's own transaction, under the space row lock the member write already holds, the actor's own
 *     LIVE `space_members` rows on the space (direct, or through a group they are in) decide whatever they can: a
 *     live row of rank ≥ the requested role is exactly what the schema reads as view (any row), edit + share (writer,
 *     admin) or direct admin (admin) on a live space (the only kind a member write reaches; nothing writes `banned`).
 *     A narrowing of those rows committed before this statement is seen here, so it cannot be raced.
 *  2. Otherwise the decision needs the PDP (a role binding, the workspace cascade). A PDP answer may lag the fork:
 *     a just-committed narrowing of the actor (a removal, a group removal, an archive) is enforced only once the
 *     relay has projected it. So the write transaction rolls back ({@link GrantNeedsPdp}), the PDP is settled to the
 *     max COMMITTED outbox position — read OUTSIDE any transaction, because a transaction holding an xid holds the
 *     relay back (the #661 trash pattern) — and the write runs once more: the local rows again, then the PDP, now at
 *     least as fresh as everything committed before the fence. Fence unconfirmed (or disabled) → `503
 *     grant_unconfirmed`; PDP unable to answer → `503` (`authzUnavailable`, #696). Never a pass.
 *  The PDP is asked for the acting human by the integrator's own principal id (`{ principalId }` = the externalId
 *  the integrator sent): no Docmost user is needed, and none is created to ask. There is no service-account leg:
 *  the integrator authorized its own caller before it called (a recorded exception to the #617 intersection rule).
 */
export class GrantNeedsPdp extends Error {
  constructor() {
    super('grant needs a PDP decision after the settle fence');
    this.name = 'GrantNeedsPdp';
  }
}

export type CeilingMode = 'local' | 'pdp';

export interface CeilingInput {
  workspaceId: string;
  spaceId: string;
  /** The actor's Docmost (shadow) user id, or null when the actor has none (it then holds no local row). */
  actorUserId: string | null;
  /** The integrator's principal id for the actor (what it sent as `addedByExternalId` / `actorExternalId`). */
  actorExternalId: string;
  role: SpaceMemberRole;
}

/** A live membership of rank ≥ the requested role's covers it locally (pinned by grant-ceiling-parity.spec.ts). */
export const ROLE_RANK: Readonly<Record<SpaceMemberRole, number>> = Object.freeze({ reader: 1, writer: 2, admin: 3 });
const rankOf = (role: string | null | undefined): number =>
  (SPACE_ROLES as readonly unknown[]).includes(role) ? ROLE_RANK[role as SpaceMemberRole] : 0;

/** The PDP checks that cover `role` when the actor's local rows do not (all must allow). */
export function pdpChecksFor(role: SpaceMemberRole, spaceId: string, workspaceId: string): AuthzCheckItem[] {
  switch (role) {
    case 'reader':
      return [{ permission: 'view', resourceType: 'space', resourceId: spaceId }];
    case 'writer':
      return [
        { permission: 'edit', resourceType: 'space', resourceId: spaceId },
        { permission: 'share', resourceType: 'space', resourceId: spaceId },
      ];
    case 'admin':
      // NOT `space#administer`: a `manage_members` binding confers administer, never admin.
      return [{ permission: 'admin_cascade', resourceType: 'workspace', resourceId: workspaceId }];
  }
}

/** 403 `grant_exceeds_actor`. The message names no space, role or principal. */
export function grantExceedsActor(): ForbiddenException {
  return refusal(
    new ForbiddenException({
      message: 'you cannot grant more access than you hold on this space',
      code: 'grant_exceeds_actor',
    }),
    'grant_exceeds_actor',
  );
}

/** 503 `grant_unconfirmed`, retryable: recent access changes could not be shown enforced before deciding. */
export function grantUnconfirmed(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'access changes could not be confirmed as enforced; nothing was granted — retry shortly',
    code: 'grant_unconfirmed',
  });
}

@Injectable()
export class SpaceGrantCeiling {
  private readonly logger = new Logger(SpaceGrantCeiling.name);
  private readonly settleMs = purgeSettleWaitMs();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly authz: HttpAuthzClient,
  ) {}

  /** The highest rank among the actor's LIVE memberships of the space: direct, or through a live group they are in. */
  async localRank(trx: KyselyTransaction, spaceId: string, actorUserId: string | null): Promise<number> {
    if (actorUserId === null) return 0;
    const res = await sql<{ role: string }>`
      select sm.role from space_members sm
      where sm.space_id = ${spaceId} and sm.deleted_at is null
        and (
          sm.user_id = ${actorUserId}
          or sm.group_id in (
            select gu.group_id from group_users gu
            join groups g on g.id = gu.group_id and g.deleted_at is null
            where gu.user_id = ${actorUserId}
          )
        )
    `.execute(trx);
    return res.rows.reduce((max, r) => Math.max(max, rankOf(r.role)), 0);
  }

  /**
   * Refuse unless the actor covers `input.role`. `local`: decided by the local rows, else {@link GrantNeedsPdp} (the
   * caller rolls back, calls {@link fence} and runs again in `pdp`). `pdp`: the local rows, else the PDP.
   */
  async assertCovers(trx: KyselyTransaction, mode: CeilingMode, input: CeilingInput): Promise<void> {
    if ((await this.localRank(trx, input.spaceId, input.actorUserId)) >= ROLE_RANK[input.role]) return;
    if (mode === 'local') throw new GrantNeedsPdp();
    const subject: AuthzSubject = { principalId: input.actorExternalId, subjectType: 'user' };
    const results = await this.authz.tryCheckBulk(subject, pdpChecksFor(input.role, input.spaceId, input.workspaceId));
    if (results === null) throw authzUnavailable();
    if (results.length === 0 || results.some((allowed) => allowed !== true)) throw grantExceedsActor();
  }

  /** Settle the PDP to the max committed outbox position, outside any transaction; anything but confirmed → 503. */
  async fence(): Promise<void> {
    const settled = await settle(this.authz, this.db, this.settleMs);
    if (settled.ok) return;
    this.logger.warn(
      `SPACE_GRANT_UNCONFIRMED reason=${settled.reason}${settled.position ? ` position=${settled.position}` : ''}: answered 503`,
    );
    throw grantUnconfirmed();
  }
}

/**
 * Run `attempt` (one whole write transaction) under the ceiling: first in `local` mode; if the local rows cannot
 * decide, fence and run it once more in `pdp` mode. `attempt` must be safe to run twice (its first run rolled back).
 */
export async function withGrantCeiling<T>(
  ceiling: Pick<SpaceGrantCeiling, 'fence'>,
  attempt: (mode: CeilingMode) => Promise<T>,
): Promise<T> {
  try {
    return await attempt('local');
  } catch (err) {
    if (!(err instanceof GrantNeedsPdp)) throw err;
  }
  await ceiling.fence();
  return attempt('pdp');
}
