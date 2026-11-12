/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036).
 *
 * Installs `ccc_page_heal_image` (heal-image.ts) in Docmost's own database, in the `IdempotencyLedgerInstaller` shape:
 * a boot installer rather than a Kysely migration (no upstream file changes, the same in dev and prod), idempotent and
 * advisory-locked so every boot and every replica may run it, and FAIL-CLOSED: a boot that cannot establish the table
 * within the bounded retry throws (`installHealImageTableAtBoot`), rather than store an order-unstable page without the
 * heal image that makes it recoverable.
 *
 * In EVERY mode, and in every process that runs the collab persistence (the main app, and the separate `collab-main`
 * process, whose CollabAppModule has no AuthzModeModule): the persistence extension calls it from its own
 * `onApplicationBootstrap` (seam #122), so it runs exactly where a store or a load can need the table. Unlike the authz
 * installers, this is not remote-only: the update guard and #827's compaction run in native mode too, and a reload-
 * unstable page is served corrupted whatever decides authorization.
 *
 *   ccc_page_heal_image(page_id) primary key, references pages(id) on delete cascade
 *     image           a verified, reload-stable compaction of the live document (#827's tree copy at the next epoch);
 *                     NULL when it could not be built or verified: the load then rebuilds it from `pages.content` when
 *                     that verifies against `content_digest`, else answers try-later until an operator acts
 *     row_sha         sha256 (base64) of the raw `pages.ydoc` it accompanies (compaction's CAS digest)
 *     epoch           the image's lineage epoch (-1: unknown, the live lineage was malformed)
 *     content_digest  live's ADR 0019 digest at that store (`stableHash` of the `content` it wrote); NULL: unknown
 *     created_at      when the store wrote it
 */
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { KyselyDB } from '@docmost/db/types/kysely.types';

export const HEAL_IMAGE_TABLE = 'ccc_page_heal_image';
/** Advisory-lock key serializing the DDL across replicas and processes. Distinct from the other CCC installers'. */
export const HEAL_IMAGE_INSTALL_LOCK_KEY = 840840001;

const sanitizeInt = (raw: string | undefined, def: number, min: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/** The idempotent DDL, serialized across replicas and processes by a transaction-scoped advisory lock. */
export async function installHealImageTable(db: KyselyDB): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local lock_timeout = '5s'`.execute(trx);
    await sql`select pg_advisory_xact_lock(${HEAL_IMAGE_INSTALL_LOCK_KEY})`.execute(trx);
    await sql`
      create table if not exists ccc_page_heal_image (
        page_id    uuid        primary key references pages(id) on delete cascade,
        image      bytea,
        row_sha    text        not null,
        epoch      integer     not null,
        created_at timestamptz not null default now(),
        content_digest text
      )
    `.execute(trx);
    // A table made by an earlier #840 build has no content_digest yet (its rows read as NULL: no rebuild from content).
    await sql`alter table ccc_page_heal_image add column if not exists content_digest text`.execute(trx);
  });
}

/** One install per database handle and process; a failed one is forgotten, so the next caller tries again. */
const ensured = new WeakMap<object, Promise<void>>();

/**
 * The table exists (installed once per handle). Every reader and writer awaits it first: in production the boot already
 * did (a resolved promise); a spec's database gets it on first use.
 */
export function ensureHealImageTable(db: KyselyDB): Promise<void> {
  let done = ensured.get(db);
  if (!done) {
    done = installHealImageTable(db);
    ensured.set(db, done);
    done.catch(() => {
      if (ensured.get(db) === done) ensured.delete(db);
    });
  }
  return done;
}

/** The boot install: bounded retries, then a throw that fails the boot (fail closed). */
export async function installHealImageTableAtBoot(
  db: KyselyDB,
  logger: Pick<Logger, 'log' | 'warn' | 'error'> = new Logger('HealImageInstaller'),
  maxAttempts = sanitizeInt(process.env.HEAL_IMAGE_INSTALL_MAX_ATTEMPTS, 15, 1),
  retryMs = sanitizeInt(process.env.HEAL_IMAGE_INSTALL_RETRY_MS, 2000, 0),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureHealImageTable(db);
      logger.log(`${HEAL_IMAGE_TABLE} ensured on Docmost DB`);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= maxAttempts) {
        logger.error(`HEAL_IMAGE_INSTALL_FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
        throw new Error(`heal image table install failed: ${msg}`);
      }
      logger.warn(`heal image table install attempt ${attempt} failed: ${msg}`);
      await new Promise((r) => {
        const t = setTimeout(r, retryMs);
        t.unref?.();
      });
    }
  }
}
