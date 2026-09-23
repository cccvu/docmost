import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { createHash } from 'crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../authz/mode/authz-mode';
import { CYCLE_LOCK_CLASS } from './page-cycle-guard.installer';
import { LIFECYCLE_MAX_DEPTH } from './page-lineage';

/** Advisory-lock key serializing the DDL across replicas (distinct from the cycle guard's and the outbox's). */
const INSTALL_LOCK_KEY = 545545001;

/** The constraint names the guard raises (SQLSTATE 23514); `PageGuardConflictInterceptor` maps them to a 409. */
export const RESTRICTED_SPACE_MOVE = 'ccc_page_restricted_space_move';
export const RESTRICTION_STRIP = 'ccc_page_restriction_strip';

const sanitizeInt = (raw: string | undefined, def: number, min: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/**
 * The walk the guard runs: from `start_id` up through `parent_page_id` (trashed and cross-space rows included), in
 * workspace `ws`, cycle-safe and bounded like `readPageLineage`. `found_restricted` = a restricted page on the walk;
 * `complete` = it reached a root. VOLATILE, so each call reads a fresh snapshot — after the caller's lock.
 */
const LINEAGE_FN = `
create or replace function ccc_page_lineage_facts(start_id uuid, ws uuid, out found_restricted boolean, out complete boolean)
language sql volatile as $fn$
  with recursive anc(id, parent_page_id, depth, path) as (
    select p.id, p.parent_page_id, 0, array[p.id]
    from pages p where p.id = start_id and p.workspace_id = ws
    union all
    select q.id, q.parent_page_id, a.depth + 1, a.path || q.id
    from anc a join pages q on q.id = a.parent_page_id and q.workspace_id = ws
    where a.depth < ${LIFECYCLE_MAX_DEPTH} and not (q.id = any(a.path))
  )
  select coalesce(bool_or(pa.page_id is not null), false), coalesce(bool_or(a.parent_page_id is null), false)
  from anc a left join page_access pa on pa.page_id = a.id
$fn$`;

/**
 * g1 + g2 on `pages`. Only a REAL change of space or parent does anything; it then takes the per-workspace lock the
 * cycle guard and g0 take (unconditionally — a lock skipped on an unlocked read would reopen the race), and only then
 * reads, so every check sees whatever a concurrent restrict or move committed first.
 *  - g1: a space change is refused for a page with its own restriction or under a restricted page (walked from its
 *    OLD parent; an unfinished walk counts as restricted). The engine's move-to-space deletes the moved pages'
 *    `page_access` rows and re-roots the page (#493 G2), so either would take a restriction away in the database.
 *  - g2: a parent change is refused when it takes a page with no restriction of its own out from under its last
 *    restricted ancestor (an unfinished walk counts as restricted before the move and as unrestricted after it).
 */
const GUARD_FN = `
create or replace function ccc_page_restriction_guard() returns trigger language plpgsql as $fn$
declare
  own boolean;
  before_restricted boolean := false;
  before_complete boolean := true;
  after_restricted boolean := false;
begin
  if new.space_id is not distinct from old.space_id
     and new.parent_page_id is not distinct from old.parent_page_id then
    return new;
  end if;
  perform pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext(new.workspace_id::text));
  select exists (select 1 from page_access pa where pa.page_id = new.id) into own;
  if old.parent_page_id is not null then
    select f.found_restricted, f.complete into before_restricted, before_complete
      from ccc_page_lineage_facts(old.parent_page_id, new.workspace_id) f;
  end if;
  if new.space_id is distinct from old.space_id
     and (own or before_restricted or not before_complete) then
    raise exception 'page % is restricted or in a restricted section and cannot move to another space', new.id
      using errcode = 'check_violation', constraint = '${RESTRICTED_SPACE_MOVE}';
  end if;
  if new.parent_page_id is distinct from old.parent_page_id
     and not own and (before_restricted or not before_complete) then
    if new.parent_page_id is not null then
      select f.found_restricted into after_restricted
        from ccc_page_lineage_facts(new.parent_page_id, new.workspace_id) f;
    end if;
    if not after_restricted then
      raise exception 'moving page % under % would take it out of its restricted section', new.id, new.parent_page_id
        using errcode = 'check_violation', constraint = '${RESTRICTION_STRIP}';
    end if;
  end if;
  return new;
end
$fn$`;

/**
 * g0 on `page_access`: a restriction written takes the same per-workspace lock, then takes its `space_id` from the
 * page itself. So a restrict and a move serialize (a restrict can no longer be erased by a move-to-space that read
 * the page before it), and `page_access.space_id` never goes stale — a stale one is deleted by the cascade when the
 * OLD space is deleted, silently lifting the restriction. The page's workspace never changes, so reading it before
 * the lock is safe; a missing page is left to the foreign key.
 */
const ACCESS_FN = `
create or replace function ccc_page_access_guard() returns trigger language plpgsql as $fn$
declare
  ws uuid;
  sp uuid;
begin
  select p.workspace_id into ws from pages p where p.id = new.page_id;
  if not found then
    return new;
  end if;
  perform pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext(ws::text));
  select p.space_id into sp from pages p where p.id = new.page_id;
  if found then
    new.space_id := sp;
  end if;
  return new;
end
$fn$`;

const GUARD_TRIGGER = `
create trigger ccc_page_restriction_guard
before update of space_id, parent_page_id on pages
for each row execute function ccc_page_restriction_guard()`;

const ACCESS_TRIGGER = `
create trigger ccc_page_access_guard
before insert or update on page_access
for each row execute function ccc_page_access_guard()`;

/** Changes whenever any DDL above does; stamped on the functions so an unchanged boot runs no DDL at all. */
export const PAGE_RESTRICTION_GUARD_VERSION = `ccc:${createHash('sha256')
  .update([LINEAGE_FN, GUARD_FN, ACCESS_FN, GUARD_TRIGGER, ACCESS_TRIGGER].join('\n'))
  .digest('hex')
  .slice(0, 16)}`;

/**
 * CCC service-bridge — NOT upstream Docmost code (#493, #545).
 *
 * Installs the database guards that keep a restriction from being taken away by anything but an explicit
 * unrestrict (or a purge): g1/g2 on `pages` (`ccc_page_restriction_guard`) and g0 on `page_access`
 * (`ccc_page_access_guard`). They are the backstop the SpiceDB projection cannot be: the engine's own move-to-space
 * deletes the subtree's restrictions and a restore that detaches from a trashed parent drops an inherited one — in
 * the database, where no projection can recover them. A refusal raises SQLSTATE 23514 with a `ccc_page_*`
 * constraint, which `PageGuardConflictInterceptor` turns into a 409; the whole statement (and its transaction) rolls
 * back, so a refused move writes nothing, outbox rows included.
 *
 * Same shape as `PageCycleGuardInstaller` — a boot installer in the excluded `service-bridge/` prefix (zero upstream
 * edits), remote-mode only, advisory-locked, FAIL-CLOSED (a remote boot that cannot establish the guard throws) —
 * and gentler on a live table: an unchanged guard (its version stamp matches and both triggers are enabled) runs no
 * DDL, and a changed one waits at most `lock_timeout` for the table lock before retrying, so a boot never queues
 * page traffic behind a long transaction.
 */
@Injectable()
export class PageRestrictionGuardInstaller implements OnApplicationBootstrap {
  private readonly logger = new Logger(PageRestrictionGuardInstaller.name);
  private readonly maxAttempts = sanitizeInt(process.env.PAGE_RESTRICTION_GUARD_INSTALL_MAX_ATTEMPTS, 30, 1);
  private readonly retryMs = sanitizeInt(process.env.PAGE_RESTRICTION_GUARD_INSTALL_RETRY_MS, 2000, 0);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'remote') {
      this.logger.log('AUTHZ_MODE is not remote — skipping page restriction guard install');
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const changed = await this.install();
        this.logger.log(`page restriction guard ${changed ? 'installed' : 'already current'} on Docmost DB (remote mode)`);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === this.maxAttempts) {
          this.logger.error(`page restriction guard install FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
          throw new Error(`page restriction guard install failed in remote mode: ${msg}`);
        }
        this.logger.warn(`page restriction guard install attempt ${attempt} failed (tables not ready or busy?): ${msg}`);
        await new Promise((r) => {
          const t = setTimeout(r, this.retryMs);
          t.unref?.();
        });
      }
    }
  }

  /** True when the installed guard is this version and both triggers are enabled. */
  async isCurrent(): Promise<boolean> {
    const res = await sql<{ current: boolean }>`
      select coalesce(
        obj_description(to_regprocedure('ccc_page_lineage_facts(uuid,uuid)'), 'pg_proc') = ${PAGE_RESTRICTION_GUARD_VERSION}
        and obj_description(to_regprocedure('ccc_page_restriction_guard()'), 'pg_proc') = ${PAGE_RESTRICTION_GUARD_VERSION}
        and obj_description(to_regprocedure('ccc_page_access_guard()'), 'pg_proc') = ${PAGE_RESTRICTION_GUARD_VERSION}
        and exists (
          select 1 from pg_trigger
          where tgname = 'ccc_page_restriction_guard' and tgrelid = to_regclass('pages')
            and tgfoid = to_regprocedure('ccc_page_restriction_guard()') and tgenabled = 'O'
        )
        and exists (
          select 1 from pg_trigger
          where tgname = 'ccc_page_access_guard' and tgrelid = to_regclass('page_access')
            and tgfoid = to_regprocedure('ccc_page_access_guard()') and tgenabled = 'O'
        ),
        false) as current
    `.execute(this.db);
    return res.rows[0]?.current === true;
  }

  /** Idempotent: returns false (and runs no DDL) when the guard is already current. */
  async install(): Promise<boolean> {
    if (await this.isCurrent()) return false;
    await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${INSTALL_LOCK_KEY})`.execute(trx);
      await sql`set local lock_timeout = '3s'`.execute(trx);
      for (const ddl of [LINEAGE_FN, GUARD_FN, ACCESS_FN]) await sql.raw(ddl).execute(trx);
      await sql`drop trigger if exists ccc_page_restriction_guard on pages`.execute(trx);
      await sql.raw(GUARD_TRIGGER).execute(trx);
      await sql`drop trigger if exists ccc_page_access_guard on page_access`.execute(trx);
      await sql.raw(ACCESS_TRIGGER).execute(trx);
      for (const fn of ['ccc_page_lineage_facts(uuid, uuid)', 'ccc_page_restriction_guard()', 'ccc_page_access_guard()']) {
        await sql.raw(`comment on function ${fn} is '${PAGE_RESTRICTION_GUARD_VERSION}'`).execute(trx);
      }
    });
    return true;
  }
}
