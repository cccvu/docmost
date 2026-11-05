import { User } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { maxCommittedPosition } from '../../service-bridge/authz-change-feed.service';
import { AuthzSubject, HttpAuthzClient } from '../http-authz.client';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6, #661, #618, #670).
 *
 * The PDP side of the remote page-removal routines: the settle fence and the all-or-nothing bulk decision.
 */

/** The longest a removal waits for the platform to confirm the settle fence. */
export const SETTLE_MAX_MS = 3000;
/** The platform's `/authz/check-bulk` caps `checks` at @ArrayMaxSize(256); larger sets are decided in chunks. */
export const DECIDE_CHUNK = 256;

/**
 * The settle wait: the SAME knob as the narrowing routes (`AUTHZ_NARROWING_SETTLE_TIMEOUT_MS`, parsed exactly as
 * `narrowingSettleTimeoutMs` in `live-access/narrowing-settle.interceptor.ts` — the purge spec cross-checks the two),
 * capped at {@link SETTLE_MAX_MS}. `0` (the narrowing rollback switch) means no fence can be proven. Not imported:
 * that module pulls the live-session revalidator's gateway graph into every importer.
 */
export function purgeSettleWaitMs(raw = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS): number {
  const fallback = 3000;
  let ms = fallback;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    ms = Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), 5000) : fallback;
  }
  return Math.min(ms, SETTLE_MAX_MS);
}

/** `ok` only when the platform confirmed the fence; otherwise `reason` says why (a short kebab-case word). */
export interface SettleResult {
  ok: boolean;
  reason?: string;
  position?: string;
}

/**
 * Settle the PDP to the max COMMITTED outbox position read now on `db` (ADR 0026 §4: never the xmin-gated head).
 * Anything but `confirmed` is `{ ok: false }`; `settleMs === 0` is `settle-disabled` with nothing read or asked.
 * `db` is the caller's transaction (the purge: read after its locks) or a pool connection with no open transaction
 * (the trash: read after its rollback — a transaction holding an xid would hold the relay back).
 */
export async function settle(
  authz: Pick<HttpAuthzClient, 'settleProjection'>,
  db: KyselyDB | KyselyTransaction,
  settleMs: number,
): Promise<SettleResult> {
  if (settleMs === 0) return { ok: false, reason: 'settle-disabled' };
  const position = await maxCommittedPosition(db as KyselyDB);
  const settled = await authz.settleProjection(position, settleMs);
  return settled.status === 'confirmed' ? { ok: true, position } : { ok: false, reason: settled.reason, position };
}

export type Decision = 'allowed' | 'denied' | 'unavailable';

/**
 * An affirmative `permission` on EVERY id for `subject`, in chunks of {@link DECIDE_CHUNK}: `allowed` only when every
 * answer is exactly `true`; `unavailable` when the PDP call failed or answered malformed (`tryCheckBulk` null); else
 * `denied`. Stops at the first chunk that is not allowed. An empty set is `allowed` (nothing to remove).
 */
export async function decideAll(
  authz: Pick<HttpAuthzClient, 'tryCheckBulk'>,
  subject: AuthzSubject,
  permission: string,
  resourceType: string,
  ids: readonly string[],
): Promise<Decision> {
  for (let i = 0; i < ids.length; i += DECIDE_CHUNK) {
    const batch = ids.slice(i, i + DECIDE_CHUNK);
    const results = await authz.tryCheckBulk(
      subject,
      batch.map((resourceId) => ({ permission, resourceType, resourceId })),
    );
    if (results === null) return 'unavailable';
    if (results.length !== batch.length || results.some((allowed) => allowed !== true)) return 'denied';
  }
  return 'allowed';
}

/** The human the request acts as (the fork's own user, by external ref — every user decision uses it). */
export function humanSubject(user: Pick<User, 'id'>): AuthzSubject {
  return { provider: 'docmost', externalId: user.id };
}

/**
 * A delegated service account (#670): the platform resolves `subjectType: 'service'` to its `service_account`
 * subject, never a user. An unknown id has no relations, so every check is denied.
 */
export function serviceSubject(principalId: string): AuthzSubject {
  return { principalId, subjectType: 'service' };
}
