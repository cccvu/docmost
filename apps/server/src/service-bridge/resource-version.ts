import { createHash } from 'crypto';
import {
  applyDecorators,
  HttpException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { sql } from 'kysely';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { stableStringify } from '../authz/page-write/stable-hash';

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #616, Stage 2).
 *
 * The fork-issued version tokens for a space, a space membership and a page's ACL, plus the small kit every
 * versioned write shares (the `expectedVersion` field, the compare, the busy mapping, the preview rollback).
 *
 * A version is an opaque sha256 hex digest of the resource's STATE, never of a timestamp alone: `updated_at` is
 * written with `now()` (µs) while JavaScript dates carry ms, and several writers never bump it at all (a grant row's
 * `updated_at` moves only on a role change). Digests are format-tagged (`ccc-v1` + the resource kind), so a token of
 * one kind can never equal a token of another. Ids are lower-cased first — a uuid is case-insensitive, and a request
 * may carry an upper-cased one.
 *
 * Who issues and who checks: the fork does both. A read computes the version from committed state; a write computes
 * it from state it read INSIDE its own transaction, under its lock, and compares the caller's `expectedVersion`
 * there — so the compare and the write are atomic. The integrating platform only carries the string (as an ETag or a
 * `version` field) and sends it back; there is no cross-service hashing contract to drift. Changing the material
 * below therefore invalidates the versions clients hold (their next conditional write 412s once and they re-read) —
 * it cannot make a stale write pass. `resource-version.spec.ts` pins the material.
 */

/** `expectedVersion: "*"` — the resource exists (any version). */
export const VERSION_ANY = '*';
export const MAX_EXPECTED_VERSION_LENGTH = 128;

/** The optional `expectedVersion` every versioned write accepts: one opaque version, or `"*"`. */
export function IsExpectedVersion(): PropertyDecorator {
  return applyDecorators(IsOptional(), IsString(), MinLength(1), MaxLength(MAX_EXPECTED_VERSION_LENGTH));
}

const FORMAT = 'ccc-v1';

function digest(kind: 'space' | 'member' | 'acl', material: unknown[]): string {
  return createHash('sha256').update(stableStringify([FORMAT, kind, ...material])).digest('hex');
}

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : (v ?? null));

/** An instant as its ms ISO string (the driver's `Date` and the wire's ISO string digest alike). */
function instant(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * Every field of the public space detail the bridge serves (`PublicSpaceSummary`, `GET service/content/spaces/:id` —
 * the `/v1` space read — and the same fields of `GET service/spaces/:id`), plus `archived`. The platform pins its
 * `SpaceDto` keys ⊆ this list, so a field it shows can never change without the version changing (a 304 can never
 * hide a change). The member count is deliberately NOT here: a member write must not 412 a rename.
 */
export const SPACE_VERSION_KEYS = [
  'id',
  'name',
  'slug',
  'description',
  'visibility',
  'createdAt',
  'updatedAt',
  'archived',
] as const;

export interface SpaceVersionMaterial {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  visibility: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  archived: boolean;
}

export function spaceVersion(s: Partial<SpaceVersionMaterial>): string {
  return digest(
    'space',
    SPACE_VERSION_KEYS.map((k) => {
      if (k === 'createdAt' || k === 'updatedAt') return instant(s[k]);
      if (k === 'id') return lower(s.id);
      if (k === 'archived') return s.archived === true;
      return s[k] ?? null;
    }),
  );
}

/** A membership row's subject: the Docmost user or group it grants a space role to. */
export type MemberType = 'user' | 'group';

export interface MemberVersionMaterial {
  spaceId: string;
  memberType: MemberType;
  /** The SUBJECT id — the Docmost user id or group id (not the `space_members` row id). */
  memberId: string | null;
  role: string;
  /** False for a soft-deleted row (the PDP projects it as removed). */
  live: boolean;
}

export function memberVersion(m: MemberVersionMaterial): string {
  return digest('member', [lower(m.spaceId), `${m.memberType}:${lower(m.memberId)}`, m.role, m.live === true]);
}

/** The member version of a `space_members` row (user row → `user:<id>`, otherwise `group:<id>`). */
export function memberRowVersion(
  spaceId: string,
  row: { userId: string | null; groupId: string | null; role: string; deletedAt?: Date | string | null },
): string {
  return memberVersion({
    spaceId,
    memberType: row.userId !== null && row.userId !== undefined ? 'user' : 'group',
    memberId: row.userId ?? row.groupId ?? null,
    role: row.role,
    live: row.deletedAt === null || row.deletedAt === undefined,
  });
}

export interface AclGrantMaterial {
  userId: string | null;
  groupId: string | null;
  role: string;
}

/** One grant as a digest entry: `u:<userId>:<role>` or `g:<groupId>:<role>`. */
export function aclEntry(g: AclGrantMaterial): string {
  return g.userId ? `u:${String(g.userId).toLowerCase()}:${g.role}` : `g:${String(g.groupId).toLowerCase()}:${g.role}`;
}

/** Code-point order, decided here rather than by a collation-dependent SQL `ORDER BY`. */
export function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** One version for the page's whole ACL: whether it is restricted, and every grant on it (order-insensitive). */
export function aclVersion(a: { pageId: string; restricted: boolean; entries: string[] }): string {
  return digest('acl', [lower(a.pageId), a.restricted === true, [...a.entries].sort(byCodePoint)]);
}

/** True when the write may proceed: no expectation, `*` on an existing resource, or an exact match. */
export function versionMatches(expected: string | undefined, current: string | null): boolean {
  if (expected === undefined) return true;
  if (current === null) return false;
  return expected === VERSION_ANY || expected === current;
}

// ---- refusals, busy engine, previews: shared by every versioned write -----------------------------------------------

const REFUSAL = Symbol('ccc.refusalCode');

/**
 * Tag a state-dependent refusal with a machine-readable code WITHOUT changing its HTTP body (the property is a
 * non-enumerable symbol). A real write answers the exception as before; a preview reports `{outcome:'refused', code}`.
 */
export function refusal<E extends HttpException>(ex: E, code: string): E {
  Object.defineProperty(ex, REFUSAL, { value: code, enumerable: false });
  return ex;
}

export function refusalCodeOf(err: unknown): string | undefined {
  return err && typeof err === 'object' ? ((err as Record<symbol, unknown>)[REFUSAL] as string | undefined) : undefined;
}

/** 412 `{ code: precondition_failed }` — the caller's version is not the current one; nothing was changed. */
export function preconditionFailed(): PreconditionFailedException {
  return refusal(
    new PreconditionFailedException({
      message: 'the resource changed since that version was read; read it again',
      code: 'precondition_failed',
    }),
    'precondition_failed',
  );
}

export function assertExpectedVersion(expected: string | undefined, current: string | null): void {
  if (!versionMatches(expected, current)) throw preconditionFailed();
}

/** Bounds on a versioned write's transaction (the same bounds as the #616 conditional page operations). */
export const VERSIONED_WRITE_LOCK_TIMEOUT = '2s';
export const VERSIONED_WRITE_STATEMENT_TIMEOUT = '15s';

export async function boundWaits(trx: KyselyTransaction): Promise<void> {
  await sql`SET LOCAL lock_timeout = ${sql.lit(VERSIONED_WRITE_LOCK_TIMEOUT)}`.execute(trx);
  await sql`SET LOCAL statement_timeout = ${sql.lit(VERSIONED_WRITE_STATEMENT_TIMEOUT)}`.execute(trx);
}

/**
 * SQLSTATEs that mean "busy, retry": lock_not_available (lock_timeout), deadlock_detected, query_canceled
 * (statement_timeout). The same set as `authz/page-write/conditional-page-ops.controller.ts` ENGINE_BUSY_SQLSTATES
 * (cross-checked by the spec; not imported, because that module pulls the collab graph into every importer).
 */
export const VERSIONED_WRITE_BUSY_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01', '57014']);

export function engineBusy(): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: 'the resource is busy; retry shortly', code: 'engine_busy' });
}

/** The retryable 503 for a busy-engine driver error, or null for any other error (which passes through). */
export function asEngineBusy(err: unknown): ServiceUnavailableException | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && VERSIONED_WRITE_BUSY_SQLSTATES.has(code) ? engineBusy() : null;
}

export type PreviewOutcome = 'would_apply' | 'noop' | 'refused';

/**
 * Thrown at the end of a preview's transaction to roll back everything the real operation just did (rows, the
 * outbox rows its triggers wrote, the NOTIFY) and hand its result out. Caught by the transaction's owner only.
 */
export class PreviewRollback<T> extends Error {
  constructor(readonly result: T) {
    super('preview: rolled back');
    this.name = 'PreviewRollback';
  }
}
