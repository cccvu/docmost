import { createHash } from 'crypto';
import { ConflictException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';

/** The ledger table (installed at boot by `IdempotencyLedgerInstaller`, remote mode only). */
export const IDEMPOTENCY_LEDGER_TABLE = 'ccc_idempotency_ledger';
/**
 * How long a key is remembered: AT LEAST this long. A row is deleted by the hourly sweep once older than this, so a
 * key lives for 24h plus up to one sweep interval — never less than the platform's own 24h replay record.
 */
export const IDEMPOTENCY_RETENTION_HOURS = 24;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
export const IDEMPOTENCY_NAMESPACE_MAX_LENGTH = 128;
/** The caller's request fingerprint: sha256 hex of its stable request body, lowercase. */
export const REQUEST_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Bounds a ledger transaction sets first: a lock not got quickly, or a statement that runs long, is a retryable 503. */
export const LEDGER_TX_LOCK_TIMEOUT = '2s';
export const LEDGER_TX_STATEMENT_TIMEOUT = '15s';

/** What a key was used for. Part of the primary key: the same key on two operations is two entries. */
export type IdempotentOp = 'page.create' | 'space.create';

/** Who is asking, as the FORK established it — never a value taken from the request body alone. */
export interface IdempotencyScope {
  workspaceId: string;
  /**
   * The identity the fork itself authenticated: `userPrincipal(user.id)` on a route relayed as the user (JWT), or the
   * service route's own acting identity. Binding it into the namespace means one caller can never replay another's
   * result, whatever namespace string either of them sends.
   */
  principal: string;
  /** The caller's opaque key namespace (the platform sends its idempotency subject, `subject[:obo:human]`), ≤128. */
  namespace: string;
}

export interface IdempotencyClaim extends IdempotencyScope {
  op: IdempotentOp;
  /** The raw key (≤255). Only its sha256 is stored. */
  key: string;
  /** sha256 hex of the caller's stable request body (`REQUEST_FINGERPRINT_PATTERN`). */
  fingerprint: string;
}

/** The ledger row a fresh reservation holds — pass it back to `complete` in the SAME transaction. */
export interface LedgerSlot {
  namespaceDigest: string;
  op: IdempotentOp;
  keyDigest: string;
}

export type Reservation =
  /** New key: the row is reserved (uncommitted) by this transaction. Create the resource, then `complete`. */
  | { outcome: 'fresh'; slot: LedgerSlot }
  /** Same key, same fingerprint, already completed and committed: return this resource, re-run nothing. */
  | { outcome: 'replay'; resourceId: string }
  /** Same key, different fingerprint: refuse (409 `idempotency_key_reused`). */
  | { outcome: 'mismatch' };

export const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The principal of a route relayed as the fork user `userId` (JwtAuthGuard). */
export const userPrincipal = (userId: string): string => `user:${userId}`;

/**
 * The stored namespace: sha256 over the JSON array [version, workspace, principal, caller namespace]. JSON-encoding
 * the parts (not concatenating them) keeps the boundaries unambiguous, so no choice of namespace string can collide
 * with another principal's.
 */
export function namespaceDigest(scope: IdempotencyScope): string {
  return sha256hex(JSON.stringify(['ccc-idempotency/v1', scope.workspaceId, scope.principal, scope.namespace]));
}

/** The 409 for a key already used with a different request. */
export function idempotencyKeyReused(): ConflictException {
  return new ConflictException({
    message: 'this idempotency key was already used with a different request',
    code: 'idempotency_key_reused',
  });
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * The durable half of create idempotency. The platform's Redis claim does not survive a relay that fails AFTER the
 * fork committed (it releases the claim, and the retry creates a duplicate). This ledger row is written in the SAME
 * transaction as the create, so "the resource exists" and "the key is used" commit or roll back together:
 *
 *   BEGIN → boundLedgerTx → reserve(trx) → fresh: create the resource with trx, complete(trx, slot, id) → COMMIT
 *                                        → replay: read the resource; re-run NO side effect
 *                                        → mismatch: 409 `idempotency_key_reused`
 *
 * A create that rolls back leaves no row. A concurrent twin with the same key blocks INSIDE the reserving INSERT
 * (Postgres waits for the in-progress inserter of the conflicting key) and then sees either the committed row (replay)
 * or nothing (the twin rolled back: it reserves fresh). The waiter is bounded by the transaction's `lock_timeout`.
 *
 * Contract for callers: a `fresh` reservation MUST be completed in the same transaction, or the transaction must roll
 * back. A committed row without a resource is a bug, answered as a 500 until the row ages out.
 */
@Injectable()
export class IdempotencyLedgerService {
  private readonly logger = new Logger(IdempotencyLedgerService.name);

  /** Reserve `claim` inside `trx`, or report the committed entry it collides with. */
  async reserve(trx: KyselyTransaction, claim: IdempotencyClaim): Promise<Reservation> {
    assertClaim(claim);
    const slot: LedgerSlot = { namespaceDigest: namespaceDigest(claim), op: claim.op, keyDigest: sha256hex(claim.key) };

    // Two rounds at most: a collision whose row vanishes before we can read it was swept (it had expired), so the key
    // is free again and the second insert reserves it.
    for (let round = 0; round < 2; round++) {
      const inserted = await sql<{ reserved: number }>`
        insert into ccc_idempotency_ledger (namespace_digest, op, key_digest, fingerprint)
        values (${slot.namespaceDigest}, ${slot.op}, ${slot.keyDigest}, ${claim.fingerprint})
        on conflict (namespace_digest, op, key_digest) do nothing
        returning 1 as reserved
      `.execute(trx);
      if (inserted.rows.length > 0) return { outcome: 'fresh', slot };

      // FOR SHARE: never read a row another transaction still holds (it waits for it instead), and keep the sweep
      // (FOR UPDATE SKIP LOCKED) off the row until this transaction ends.
      const existing = await sql<{ fingerprint: string; resourceId: string | null }>`
        select fingerprint, resource_id as "resourceId" from ccc_idempotency_ledger
        where namespace_digest = ${slot.namespaceDigest} and op = ${slot.op} and key_digest = ${slot.keyDigest}
        for share
      `.execute(trx);
      const row = existing.rows[0];
      if (!row) continue;
      if (row.fingerprint !== claim.fingerprint) return { outcome: 'mismatch' };
      if (!row.resourceId) {
        this.logger.error(
          `IDEMPOTENCY_LEDGER_INCOMPLETE op=${slot.op}: a committed reservation has no resource ` +
            '(a caller committed without complete())',
        );
        throw new InternalServerErrorException('idempotency ledger entry is incomplete');
      }
      return { outcome: 'replay', resourceId: row.resourceId };
    }
    throw new InternalServerErrorException('idempotency ledger reservation did not settle');
  }

  /** Record the resource a fresh reservation created, in the SAME transaction as the reservation. */
  async complete(trx: KyselyTransaction, slot: LedgerSlot, resourceId: string): Promise<void> {
    const updated = await sql<{ completed: number }>`
      update ccc_idempotency_ledger set resource_id = ${resourceId}::uuid
      where namespace_digest = ${slot.namespaceDigest} and op = ${slot.op} and key_digest = ${slot.keyDigest}
        and resource_id is null
      returning 1 as completed
    `.execute(trx);
    if (updated.rows.length !== 1) {
      // Not this transaction's reservation (or completed twice): refuse, so the whole create rolls back.
      throw new InternalServerErrorException('idempotency ledger reservation not held by this transaction');
    }
  }
}

/** Set the ledger transaction's bounds. Call first thing inside the transaction that reserves. */
export async function boundLedgerTx(trx: KyselyTransaction): Promise<void> {
  await sql`SET LOCAL lock_timeout = ${sql.lit(LEDGER_TX_LOCK_TIMEOUT)}`.execute(trx);
  await sql`SET LOCAL statement_timeout = ${sql.lit(LEDGER_TX_STATEMENT_TIMEOUT)}`.execute(trx);
}

/** Programming-error guard: the DTOs validate these, so a bad claim here is a caller bug, never user input. */
function assertClaim(c: IdempotencyClaim): void {
  const bad = (what: string) => {
    throw new Error(`IdempotencyLedgerService.reserve: invalid ${what}`);
  };
  if (typeof c.workspaceId !== 'string' || !c.workspaceId) bad('workspaceId');
  if (typeof c.principal !== 'string' || !c.principal) bad('principal');
  const bounded = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!bounded(c.namespace, IDEMPOTENCY_NAMESPACE_MAX_LENGTH)) bad('namespace');
  if (!bounded(c.key, IDEMPOTENCY_KEY_MAX_LENGTH)) bad('key');
  if (typeof c.fingerprint !== 'string' || !REQUEST_FINGERPRINT_PATTERN.test(c.fingerprint)) bad('fingerprint');
  if (c.op !== 'page.create' && c.op !== 'space.create') bad('op');
}
