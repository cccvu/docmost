import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../authz/mode/authz-mode';

/** Advisory-lock key serializing the DDL across replicas (distinct from the outbox installer's). */
const INSTALL_LOCK_KEY = 485485001;

/** First half of the per-workspace transaction lock the trigger takes; the second half hashes the workspace. */
export const CYCLE_LOCK_CLASS = 485485;

/** Walk bound inside the trigger. A walk that reaches it is refused — a tree that deep is not a real tree. */
export const CYCLE_GUARD_MAX_DEPTH = 1024;

const sanitizeInt = (raw: string | undefined, def: number, min: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/**
 * CCC service-bridge — NOT upstream Docmost code (#485).
 *
 * Installs `ccc_page_cycle_guard`, a `BEFORE UPDATE OF parent_page_id ON pages` trigger that refuses a parent
 * which is the page itself or one of its descendants. The engine has no cycle check at all: a cycle makes every
 * recursive tree query loop to its bound and trips SpiceDB `locked` evaluation. The platform's `/v1` move gives
 * the friendly `409 move_cycle` from a pre-check; THIS is the backstop that closes the race between two
 * concurrent moves (A under B while B moves under A) and covers the engine's own UI path too.
 *
 * Race-safety: the trigger takes a per-workspace `pg_advisory_xact_lock` BEFORE walking, so two re-parents in
 * one workspace serialize; under READ COMMITTED the walk (a new statement after the lock) sees the other
 * transaction's committed parent. Fails closed: a walk that reaches the depth bound is refused too.
 *
 * Same shape as `AuthzOutboxInstaller`: a boot installer in the excluded `service-bridge/` prefix (zero upstream
 * edits), remote-mode only, advisory-locked, idempotent, and FAIL-CLOSED — a remote boot that cannot establish
 * the guard throws rather than run without it.
 */
@Injectable()
export class PageCycleGuardInstaller implements OnApplicationBootstrap {
  private readonly logger = new Logger(PageCycleGuardInstaller.name);
  private readonly maxAttempts = sanitizeInt(process.env.PAGE_CYCLE_GUARD_INSTALL_MAX_ATTEMPTS, 30, 1);
  private readonly retryMs = sanitizeInt(process.env.PAGE_CYCLE_GUARD_INSTALL_RETRY_MS, 2000, 0);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'remote') {
      this.logger.log('AUTHZ_MODE is not remote — skipping page cycle guard install');
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.install();
        this.logger.log('page cycle guard ensured on Docmost DB (remote mode)');
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === this.maxAttempts) {
          this.logger.error(`page cycle guard install FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
          throw new Error(`page cycle guard install failed in remote mode: ${msg}`);
        }
        this.logger.warn(`page cycle guard install attempt ${attempt} failed (Docmost tables not ready?): ${msg}`);
        await new Promise((r) => {
          const t = setTimeout(r, this.retryMs);
          t.unref?.();
        });
      }
    }
  }

  /** The idempotent DDL, serialized across replicas/processes by a transaction-scoped advisory lock. */
  async install(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${INSTALL_LOCK_KEY})`.execute(trx);
      await sql
        .raw(
          `
        create or replace function ccc_page_cycle_guard() returns trigger language plpgsql as $$
        declare
          closes_loop boolean;
        begin
          if new.parent_page_id is null or new.parent_page_id is not distinct from old.parent_page_id then
            return new;
          end if;
          if new.parent_page_id = new.id then
            raise exception 'a page cannot be its own parent'
              using errcode = 'check_violation', constraint = 'ccc_page_no_cycle';
          end if;
          perform pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext(new.workspace_id::text));
          with recursive anc(id, parent_page_id, depth, path) as (
            select p.id, p.parent_page_id, 0, array[p.id]
            from pages p where p.id = new.parent_page_id
            union all
            select q.id, q.parent_page_id, a.depth + 1, a.path || q.id
            from anc a join pages q on q.id = a.parent_page_id
            where a.depth < ${CYCLE_GUARD_MAX_DEPTH} and not (q.id = any(a.path))
          )
          select exists (select 1 from anc where id = new.id)
              or exists (select 1 from anc where depth >= ${CYCLE_GUARD_MAX_DEPTH} and parent_page_id is not null)
            into closes_loop;
          if closes_loop then
            raise exception 'moving page % under % would create a cycle', new.id, new.parent_page_id
              using errcode = 'check_violation', constraint = 'ccc_page_no_cycle';
          end if;
          return new;
        end
        $$`,
        )
        .execute(trx);
      await sql`drop trigger if exists ccc_page_cycle_guard on pages`.execute(trx);
      await sql`
        create trigger ccc_page_cycle_guard
        before update of parent_page_id on pages
        for each row execute function ccc_page_cycle_guard()
      `.execute(trx);
    });
  }
}
