/**
 * CCC collab integration — NOT upstream Docmost code (#793, ADR 0036 #793 amendment).
 *
 * The update guard binds each Yjs client id to its user in memory, per document lifetime (update-guard.ts). A reload
 * (a deploy drain, the last user leaving) used to start with none, so an editor who saw a co-editor V's id could write
 * at V's next clocks before V reconnected, and V's offline edits at those clocks were dropped. This module carries the
 * bindings across a CLEAN unload only, in the server-only table `ccc_collab_binding_seal` (heal-image.installer.ts),
 * never in a Y root (a root reaches every viewer and every IndexedDB copy):
 *
 *   - Claim at load (`claimAtLoad`, the end of `loadStableYdoc`): one transaction locks the page's row, returns it, and
 *     overwrites it with a new `lifetime_id` and no seal. So every seal is consumed by the next load, and a lifetime
 *     that then ends unclean (a crash, a kill past the stop timeout, a failed final store, a wedge) leaves only that
 *     claim behind: the load after it restores nothing, which is the behaviour before #793. A failed claim is
 *     try-later (`pageCompactingRefusal`), the row read's own failure domain.
 *   - Restore: only on the plain row branch (a heal or a swap moves the epoch), and per entry only when the seal names
 *     exactly this row (`row_sha`: the bytes live last covered, so live held every struct in them), the same lineage
 *     epoch, the loaded clock at that id equals the sealed clock (live's clock there at the unload), and the id is not
 *     the new server id. Equal clocks over bytes live covered mean the row holds every struct live ever accepted at
 *     that id, so nobody can honestly hold a newer one; an id live advanced past the row (a net-zero tail, which an
 *     unchanged-JSON store never writes; a final store that failed) is left unbound, as before. The guard adopts what is restored AWARENESS-ONLY, in
 *     every mode (collab-update-guard.extension.ts `afterLoadDocument`): a peer's relay there stays `unresolved` until
 *     its owner's claim covers it (#842), and only the owner's own struct proves the id again.
 *   - Seal at a committed unload: the guard snapshots its bindings in the live document's `destroy` handler (Hocuspocus
 *     4.7.1 destroys a document only after its last `shouldUnloadDocument` check, so an unload a join aborted seals
 *     nothing), naming the row bytes live last covered (`coveredRowDigest`; none, or a wedged live: no seal) and each id
 *     with live's clock. A lifetime that changed nothing, or only viewed, seals too: its restored ids stay protected.
 *     The extension's `afterUnloadDocument` commits it (`commitPendingSeal`) with `where lifetime_id = <this lifetime>`.
 *     A same-node reload's claim first waits for that commit (`awaitPendingCommit`, at most SEAL_BARRIER_MS: Hocuspocus
 *     4.7.1 starts a new load without waiting for the old unload's hooks); past the bound it claims anyway and the late
 *     commit touches nothing (the cross-node backstop too). It never throws (a throw would stop RedisSync releasing the
 *     document's lock): a failure logs `COLLAB_BINDING_SEAL_FAILED` and the next load is unclean.
 *   - A lifetime that loaded no stored ydoc (a fresh page, a content-only row) ran no claim: it seals through the boot's
 *     handle (`bootSealDb`) insert-if-absent, so a row any later load already claimed is never overwritten.
 *   - The epoch moves only in compaction's `swapYdoc`, which deletes the row in its own transaction
 *     (`deleteSealInTransaction`).
 *
 * This file is the table's only writer (binding-seal.fitness.spec.ts). Logs, fixed words and numbers only:
 * `COLLAB_BINDINGS_NOT_RESTORED {"pageId","reason":"none"|"unclean"|"stale_sha"|"clock"|"epoch",…}` (`unclean`: the
 * previous lifetime never sealed, the crash rate) and `COLLAB_BINDING_SEAL_FAILED {"pageId","stage":"claim"|"commit"}`.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { sql } from 'kysely';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { pageCompactingRefusal } from '../collab-ingress/collab-reasons';
import { C_MAX } from '../collab-ingress/doc-bounds';
import { RateLimitedWarn } from '../collab-ingress/socket-limit-log';
import { lineageEpoch } from './compaction-registry';
import { bootSealDb, ensureHealImageTable } from './heal-image.installer';

export const COLLAB_BINDINGS_NOT_RESTORED_TOKEN = 'COLLAB_BINDINGS_NOT_RESTORED';
export const COLLAB_BINDING_SEAL_FAILED_TOKEN = 'COLLAB_BINDING_SEAL_FAILED';
/** At most this many ids are sealed per page (the most recently proven are kept): the page's client-id cap. */
export const SEAL_ENTRIES_MAX = C_MAX;

/** One sealed binding: the client id, its user, and live's clock at that id when the seal was taken. */
export type SealEntry = [clientId: number, userId: string, clock: number];

/** The page's row as a claim found it. `entries` null: a claimed row no lifetime sealed. */
export interface SealRow {
  lifetimeId: string;
  epoch: number | null;
  rowSha: string | null;
  entries: SealEntry[] | null;
}

/** What a committed unload seals. */
export interface Seal {
  epoch: number;
  rowSha: string;
  entries: SealEntry[];
}

/** The two statements a lifetime needs (on HealImageStore, so the unit specs run without Postgres). */
export interface BindingSealStore {
  /** One transaction: the page's row (locked), then the row overwritten with `lifetimeId` and no seal. */
  claimSeal(pageId: string, lifetimeId: string): Promise<SealRow | null>;
  /** Seal `lifetimeId`'s row (`claimed`), or insert one where none exists (not claimed). Rows written: 0 or 1. */
  commitSeal(pageId: string, lifetimeId: string, claimed: boolean, seal: Seal): Promise<number>;
}

// --- the statements (the table's only writer)

const isEntry = (e: unknown): e is SealEntry =>
  Array.isArray(e) &&
  e.length === 3 &&
  Number.isSafeInteger(e[0]) &&
  (e[0] as number) >= 0 &&
  typeof e[1] === 'string' &&
  e[1].length > 0 &&
  Number.isSafeInteger(e[2]) &&
  (e[2] as number) >= 0;

function parseEntries(text: string | null): SealEntry[] | null {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
}

export async function claimSealRow(db: KyselyDB, pageId: string, lifetimeId: string): Promise<SealRow | null> {
  await ensureHealImageTable(db);
  return db.transaction().execute(async (trx) => {
    await sql`set local lock_timeout = '2s'`.execute(trx);
    await sql`set local statement_timeout = '5s'`.execute(trx);
    // Aliases without underscores, so the CamelCasePlugin leaves them as written; `entries::text`, parsed here.
    const { rows } = await sql<{ lifetimeid: string; epoch: number | null; rowsha: string | null; entries: string | null }>`
      select lifetime_id as lifetimeid, epoch, row_sha as rowsha, entries::text as entries
      from ccc_collab_binding_seal where page_id = ${pageId} for update`.execute(trx);
    await sql`
      insert into ccc_collab_binding_seal (page_id, lifetime_id) values (${pageId}, ${lifetimeId})
      on conflict (page_id) do update
        set lifetime_id = excluded.lifetime_id, epoch = null, row_sha = null, entries = null, sealed_at = null`.execute(trx);
    const r = rows[0];
    if (!r) return null;
    return { lifetimeId: r.lifetimeid, epoch: r.epoch === null ? null : Number(r.epoch), rowSha: r.rowsha, entries: parseEntries(r.entries) };
  });
}

export async function commitSealRow(db: KyselyDB, pageId: string, lifetimeId: string, claimed: boolean, seal: Seal): Promise<number> {
  await ensureHealImageTable(db);
  const entries = JSON.stringify(seal.entries);
  return db.transaction().execute(async (trx) => {
    await sql`set local lock_timeout = '2s'`.execute(trx);
    await sql`set local statement_timeout = '5s'`.execute(trx);
    const result = claimed
      ? await sql`
          update ccc_collab_binding_seal
             set epoch = ${seal.epoch}, row_sha = ${seal.rowSha}, entries = ${entries}::text::jsonb, sealed_at = now()
           where page_id = ${pageId} and lifetime_id = ${lifetimeId}
          returning page_id`.execute(trx)
      : await sql`
          insert into ccc_collab_binding_seal (page_id, lifetime_id, epoch, row_sha, entries, sealed_at)
          values (${pageId}, ${lifetimeId}, ${seal.epoch}, ${seal.rowSha}, ${entries}::text::jsonb, now())
          on conflict (page_id) do nothing
          returning page_id`.execute(trx);
    return result.rows.length;
  });
}

/** In compaction's swap transaction (the epoch moves): the page's row goes with it. */
export async function deleteSealInTransaction(trx: KyselyDB, pageId: string): Promise<void> {
  await sql`delete from ccc_collab_binding_seal where page_id = ${pageId}`.execute(trx);
}

/** The Postgres statements for a Kysely handle (the boot handle's, for a lifetime that loaded no stored ydoc). */
export function kyselyBindingSealStore(db: KyselyDB): BindingSealStore {
  return {
    claimSeal: (pageId, lifetimeId) => claimSealRow(db, pageId, lifetimeId),
    commitSeal: (pageId, lifetimeId, claimed, seal) => commitSealRow(db, pageId, lifetimeId, claimed, seal),
  };
}

// --- the logs

export type NotRestoredReason = 'none' | 'unclean' | 'stale_sha' | 'clock' | 'epoch';

/** Where the lines go (the specs spy on it). */
export const bindingSealLogSink: { warn(line: string): void } = {
  warn: (line) => defaultLogger.warn(line),
};
const defaultLogger = new Logger('CollabBindingSeal');
/** Lines per token and reason a minute; the rest are counted into one summary line. */
const SEAL_LOGS_PER_MINUTE = 30;
let lines = newLines();
function newLines(): RateLimitedWarn<string> {
  return new RateLimitedWarn<string>({
    logger: { warn: (line) => bindingSealLogSink.warn(line) },
    perKey: SEAL_LOGS_PER_MINUTE,
    summary: (key, count) => {
      const [token, of] = key.split(':');
      return `${token} ${JSON.stringify({ reason: 'log_suppressed', of, count })}`;
    },
  });
}
/** The specs: a fresh rate-limit window. */
export function resetBindingSealLogForTests(): void {
  lines = newLines();
}

function logNotRestored(pageId: string, reason: NotRestoredReason, counts: Record<string, number> = {}): void {
  lines.warn(`${COLLAB_BINDINGS_NOT_RESTORED_TOKEN}:${reason}`, () => `${COLLAB_BINDINGS_NOT_RESTORED_TOKEN} ${JSON.stringify({ pageId, reason, ...counts })}`);
}

function logSealFailed(pageId: string, stage: 'claim' | 'commit'): void {
  lines.warn(`${COLLAB_BINDING_SEAL_FAILED_TOKEN}:${stage}`, () => `${COLLAB_BINDING_SEAL_FAILED_TOKEN} ${JSON.stringify({ pageId, stage })}`);
}

// --- one document lifetime

/** A document lifetime's seal: who may commit it, through what, and what its load restored. */
export interface SealLifetime {
  pageId: string;
  lifetimeId: string;
  /** Its load claimed the row (`loadStableYdoc`); false: it loaded no stored ydoc and seals insert-if-absent. */
  claimed: boolean;
  store: BindingSealStore;
  /** The bindings its load restored, for the guard to adopt awareness-only. */
  restored: SealEntry[];
}

const lifetimes = new WeakMap<object, SealLifetime>();

/** The lifetime registered for `document` (its load's claim, or `unclaimedLifetime`), if any. */
export function sealLifetimeOf(document: object): SealLifetime | undefined {
  return lifetimes.get(document);
}

/**
 * What a claim's previous row restores into the loaded `document`: nothing unless the row was sealed, the load took the
 * plain row branch (`rowSha`, null for a heal), the seal names that row and the document's lineage epoch; then every
 * entry whose id is not the server's and whose loaded clock equals the sealed one. Logged when anything is not restored.
 */
export function restorable(document: Y.Doc, pageId: string, prev: SealRow | null, rowSha: string | null): SealEntry[] {
  if (prev === null) return none(pageId, 'none');
  if (prev.entries === null) return none(pageId, 'unclean');
  if (prev.entries.length === 0) return none(pageId, 'none');
  if (rowSha === null) return none(pageId, 'epoch', prev.entries.length);
  if (prev.rowSha !== rowSha) return none(pageId, 'stale_sha', prev.entries.length);
  let epoch: number;
  try {
    epoch = lineageEpoch(document);
  } catch {
    return none(pageId, 'epoch', prev.entries.length); // a malformed lineage: never guessed
  }
  if (prev.epoch !== epoch) return none(pageId, 'epoch', prev.entries.length);
  const kept: SealEntry[] = [];
  for (const entry of prev.entries) {
    const [client, , clock] = entry;
    if (client !== document.clientID && Y.getState(document.store, client) === clock) kept.push(entry);
  }
  if (kept.length < prev.entries.length) logNotRestored(pageId, 'clock', { entries: prev.entries.length, restored: kept.length });
  return kept;
}

function none(pageId: string, reason: NotRestoredReason, entries?: number): SealEntry[] {
  logNotRestored(pageId, reason, entries === undefined ? {} : { entries });
  return [];
}

/**
 * The end of `loadStableYdoc`, on every branch that loaded: claim the page's row for this lifetime (consuming the
 * previous seal) and register what it restores. `rowSha`: the digest of the row bytes the plain branch applied (null
 * after a heal, which moved the epoch: nothing restored). A claim that fails throws the try-later refusal.
 */
export async function claimAtLoad(document: Y.Doc, pageId: string, store: BindingSealStore, rowSha: string | null): Promise<void> {
  const lifetimeId = randomUUID();
  await awaitPendingCommit(pageId); // a same-node reload: the previous lifetime's seal first
  let prev: SealRow | null;
  try {
    prev = await store.claimSeal(pageId, lifetimeId);
  } catch {
    logSealFailed(pageId, 'claim');
    throw pageCompactingRefusal();
  }
  lifetimes.set(document, { pageId, lifetimeId, claimed: true, store, restored: restorable(document, pageId, prev, rowSha) });
}

/**
 * A lifetime whose load applied no stored ydoc (no claim ran): sealed through the boot's handle, insert-if-absent.
 * Undefined when the process never booted the tables (the specs) or for a document that is not a page.
 */
export function unclaimedLifetime(document: object, pageId: string | null, db: KyselyDB | null = bootSealDb()): SealLifetime | undefined {
  const known = lifetimes.get(document);
  if (known) return known;
  if (!db || !pageId) return undefined;
  const lifetime: SealLifetime = { pageId, lifetimeId: randomUUID(), claimed: false, store: kyselyBindingSealStore(db), restored: [] };
  lifetimes.set(document, lifetime);
  return lifetime;
}

// --- the unload

/** Seals snapshot at a document's destroy, by document name, until its `afterUnloadDocument` commits them. */
const pending = new Map<string, { lifetime: SealLifetime; seal: Seal; done: () => void }>();
/** Per page: the noted seal's commit, settled (whatever its outcome) when it ends. What a same-node claim waits for. */
const commits = new Map<string, Promise<void>>();
/** How long a claim waits for a same-node commit: a commit's own lock and statement timeouts are 2 s and 5 s. */
export const SEAL_BARRIER_MS = 3_000;
let barrierMs = SEAL_BARRIER_MS;
/** The specs: another barrier bound; returns the restore. */
export function setSealBarrierMsForTests(ms: number): () => void {
  barrierMs = ms;
  return () => {
    barrierMs = SEAL_BARRIER_MS;
  };
}

/**
 * The claim's barrier: the commit of a seal noted for `pageId` in this process and not yet ended, awaited for at most
 * the barrier bound (then the claim goes ahead, and the late commit's `lifetime_id` predicate makes it a no-op). Never
 * rejects.
 */
export async function awaitPendingCommit(pageId: string): Promise<void> {
  const commit = commits.get(pageId);
  if (!commit) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    commit,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, barrierMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}
/** A destroy no unload follows (a failed load) leaves its entry until the name unloads again: bounded. */
const PENDING_MAX = 10_000;

/**
 * The guard's live `destroy` handler: `seal` is what `documentName`'s lifetime commits at its `afterUnloadDocument`.
 * Only for a registered lifetime; synchronous, never throws.
 */
export function noteSeal(document: object, documentName: string, seal: Seal): void {
  const lifetime = lifetimes.get(document);
  if (!lifetime) return;
  pending.get(documentName)?.done(); // an earlier note no unload followed: nothing commits it now
  pending.delete(documentName);
  if (pending.size >= PENDING_MAX) {
    const [name, oldest] = pending.entries().next().value;
    oldest.done();
    pending.delete(name);
  }
  let done!: () => void;
  const commit = new Promise<void>((resolve) => (done = resolve));
  const pageId = lifetime.pageId;
  commits.set(pageId, commit);
  const settle = () => {
    done();
    if (commits.get(pageId) === commit) commits.delete(pageId);
  };
  pending.set(documentName, { lifetime, seal: { ...seal, entries: seal.entries.slice(-SEAL_ENTRIES_MAX) }, done: settle });
}

/**
 * The extension's `afterUnloadDocument`: commit the seal `documentName`'s destroy noted (none: nothing to do). Rows
 * written (0: a later load claimed the row first, or nothing was pending). NEVER rejects.
 */
export async function commitPendingSeal(documentName: string): Promise<number> {
  const noted = pending.get(documentName);
  if (!noted) return 0;
  pending.delete(documentName);
  const { lifetime, seal, done } = noted;
  try {
    return await lifetime.store.commitSeal(lifetime.pageId, lifetime.lifetimeId, lifetime.claimed, seal);
  } catch {
    logSealFailed(lifetime.pageId, 'commit');
    return 0;
  } finally {
    done(); // a same-node claim waiting on it goes ahead
  }
}
