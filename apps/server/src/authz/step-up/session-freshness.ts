import { BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #713).
 *
 * Step-up freshness of ONE fork session. The platform decides when its human last proved presence (`authTime`, the
 * OIDC `auth_time` of the platform token that asked for the mint) and until when that counts as recent
 * (`freshUntil`). It passes both, east-west and service-authenticated, on `POST /api/service/session`; a browser can
 * never set them. The fork stores them on THAT session's own `user_sessions.metadata` row and never updates them:
 * a step-up re-mint creates a NEW row, so an older token (its own row) stays exactly as stale as it was. Freshness is
 * per row, never per user.
 *
 * Absent on the mint ⇒ the session is simply not fresh. `RemoteStepUpInterceptor` reads the request's own row and
 * refuses the admin-tier routes in `remote-step-up.table.ts` unless `now < freshUntil`.
 */
export interface SessionFreshness {
  /** Epoch seconds: when the human last authenticated to the platform. */
  readonly authTime: number;
  /** Epoch seconds: the session counts as freshly authenticated strictly before this instant. */
  readonly freshUntil: number;
}

/**
 * The fork's own ceiling on `freshUntil - authTime`. The platform's window is far shorter (2h by default); this only
 * bounds the damage a platform bug could do, so a mint can never grant a long-lived "fresh" session.
 */
export const MAX_FRESH_WINDOW_SECONDS = 24 * 60 * 60;

/** Clock skew tolerated between the platform's `authTime` and this process's clock. */
export const AUTH_TIME_SKEW_SECONDS = 60;

export const nowEpochSeconds = (): number => Math.floor(Date.now() / 1000);

const isEpochInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The window rules, shared by the mint (400 on a violation) and the read (a violating row is never fresh). */
function windowViolation(authTime: number, freshUntil: number, nowSec: number): string | undefined {
  if (authTime > nowSec + AUTH_TIME_SKEW_SECONDS) return 'authTime must not be in the future';
  if (freshUntil <= authTime) return 'freshUntil must be after authTime';
  if (freshUntil - authTime > MAX_FRESH_WINDOW_SECONDS) {
    return `freshUntil must be at most ${MAX_FRESH_WINDOW_SECONDS}s after authTime`;
  }
  return undefined;
}

/**
 * The mint's freshness, from the DTO's two optional fields (each already `@IsInt @Min(0)`): `undefined` when both are
 * absent (the session is not fresh), the pair when both are present and within the window, a 400 otherwise. One
 * without the other is a 400 too: half a statement about freshness is a caller bug, never something to guess at.
 */
export function mintFreshness(
  authTime: number | undefined,
  freshUntil: number | undefined,
  nowSec: number = nowEpochSeconds(),
): SessionFreshness | undefined {
  if (authTime === undefined && freshUntil === undefined) return undefined;
  if (authTime === undefined || freshUntil === undefined) {
    throw new BadRequestException(['authTime and freshUntil must be sent together']);
  }
  if (!isEpochInt(authTime) || !isEpochInt(freshUntil)) {
    throw new BadRequestException(['authTime and freshUntil must be non-negative integer epoch seconds']);
  }
  const violation = windowViolation(authTime, freshUntil, nowSec);
  if (violation) throw new BadRequestException([violation]);
  return { authTime, freshUntil };
}

/**
 * The freshness recorded on a `user_sessions.metadata` value, or `undefined` for anything else (null, garbage, a
 * missing or non-integer field). The value arrives as an object from the production driver and as a JSON string under
 * jest (postgres.js jsonb parsing differs), so both are accepted. Never throws.
 */
export function parseSessionFreshness(metadata: unknown): SessionFreshness | undefined {
  let value: unknown = metadata;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { authTime, freshUntil } = value as Record<string, unknown>;
  return isEpochInt(authTime) && isEpochInt(freshUntil) ? { authTime, freshUntil } : undefined;
}

/**
 * Whether a session with this recorded freshness counts as freshly authenticated at `nowSec`. Fail closed: no record,
 * a record that breaks the mint's window rules (a tampered row, a future `authTime`), or `now >= freshUntil` is stale.
 */
export function isFreshAt(freshness: SessionFreshness | undefined, nowSec: number): boolean {
  if (!freshness) return false;
  if (windowViolation(freshness.authTime, freshness.freshUntil, nowSec)) return false;
  return nowSec < freshness.freshUntil;
}

/**
 * Record `freshness` on exactly the session row `sessionId` of `userId`, merged into its metadata. Returns whether one
 * row was written. Never touches another row of the same user: freshness is per session.
 */
export async function stampSessionFreshness(
  db: KyselyDB,
  sessionId: string,
  userId: string,
  freshness: SessionFreshness,
): Promise<boolean> {
  const result = await db
    .updateTable('userSessions')
    .set({
      metadata: sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('authTime', ${freshness.authTime}::bigint, 'freshUntil', ${freshness.freshUntil}::bigint)`,
    })
    .where('id', '=', sessionId)
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .executeTakeFirst();
  return BigInt(result?.numUpdatedRows ?? 0) === BigInt(1);
}
