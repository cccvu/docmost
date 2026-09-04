import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../authz/mode/authz-mode';

/** Advisory-lock key so concurrent replicas / processes serialize the DDL (no DROP/CREATE-trigger race). */
const INSTALL_LOCK_KEY = 774615092310;

const sanitizeInt = (raw: string | undefined, def: number, min: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/**
 * CCC service-bridge — NOT upstream Docmost code (Group D, issue #171).
 *
 * Installs the transactional-outbox table + `authz_outbox_capture()` trigger function + the AFTER triggers
 * INSIDE Docmost's OWN database, at boot, when (and only when) `AUTHZ_MODE=remote`. This is the change-data-
 * capture the platform's authz change feed drains. It moved here FROM the platform (which used to reach into
 * Docmost's DB to install it): the fork owns its schema, so the platform can drop its Docmost DB credentials
 * + DDL/NOTIFY privileges entirely.
 *
 * At-least-once + atomicity is UNCHANGED: the AFTER trigger writes the outbox row inside Docmost's own write
 * transaction (every write path, all-or-nothing), then `pg_notify` wakes any long-poll. The capture function
 * stores ONLY the authz-relevant columns per table (data minimization + no write amplification — never the
 * large `pages.content`/`ydoc`) and ENRICHES `page_permissions` with `page_id` (resolved from `page_access`
 * while the RI cascade still leaves it visible), so the change feed never needs a live `page_access` lookup.
 *
 * Design choices:
 *  - A boot installer, NOT a Kysely migration: it runs uniformly in dev + prod (auto-migrate is prod-only),
 *    is GATED on remote mode (native standalone Docmost installs NO CCC DDL), and lives entirely in the
 *    excluded `service-bridge/` prefix (zero upstream-file edits).
 *  - Idempotent + advisory-locked: safe to run on every boot and on every replica.
 *  - Safe under MULTIPLE processes: the advisory lock serializes the DDL and it is idempotent. NB:
 *    ServiceBridgeModule is reachable from BOTH entrypoints (the main API AND the separate collab server, via
 *    DatabaseModule -> AuthzModule), so if the collab process is started it ALSO runs this installer + a
 *    LISTEN + a GC timer. That is currently dormant (the image CMD never starts `collab:prod` and nothing
 *    wires a separate collab service) and harmless (advisory-locked DDL + idempotent age-GC); the change-feed
 *    HTTP routes are served by the main API. A dedicated main-API-only gate is a follow-up if the collab
 *    process is ever enabled.
 *  - Superset-compatible with the platform's LEGACY `authz_outbox` (keeps `processed_at`/`attempts`/`error`
 *    + the `authz_outbox` NOTIFY channel) so the OLD platform still drains it during the R1 rollout window.
 *    During that window BOTH this installer and the platform's legacy `ensureAuthzOutbox` `create or replace`
 *    the SAME capture function (last-writer-wins) and both install the triggers; this is benign in R1 (no
 *    fork consumer drains the feed yet), self-heals, and the legacy installer is retired at R2. The legacy
 *    function lacks the page_id enrichment, so if it wins the race the feed's page_permissions events would
 *    carry no page_id until this installer re-runs — inert in R1 (no consumer), and R2 removes the legacy
 *    writer. (Documented for the rollout runbook.)
 *  - FAIL-CLOSED in remote: if the table + triggers cannot be established after the bounded retry, it THROWS
 *    (Nest aborts boot -> the container crashes + alarms) rather than run without CDC (a silent authorization
 *    drift). The internal LISTEN is a latency optimization owned by the feed service and is best-effort (the
 *    backstop poll is the correctness path), consistent with "the durable outbox is the source of truth".
 */
@Injectable()
export class AuthzOutboxInstaller implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthzOutboxInstaller.name);
  // Bounded retry for the TRANSIENT "Docmost's own migrations have not created the tables yet" case (module
  // init order does NOT guarantee migrations ran before this bootstrap: DatabaseModule imports AuthzModule).
  // After the bound, FAIL the boot in remote rather than run without CDC. Read from env at construction so
  // the fail-closed path is unit-testable (defaults match the platform's proven boot-ensure: 30 x 2s).
  private readonly maxAttempts = sanitizeInt(process.env.AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS, 30, 1);
  private readonly retryMs = sanitizeInt(process.env.AUTHZ_OUTBOX_INSTALL_RETRY_MS, 2000, 0);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'remote') {
      this.logger.log('AUTHZ_MODE is not remote — skipping authz outbox install (no CCC CDC in native)');
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.install();
        this.logger.log('authz_outbox table + capture trigger ensured on Docmost DB (remote mode)');
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === this.maxAttempts) {
          // Fail-closed: in remote mode a missing feed = silent authorization drift. Crash the boot.
          this.logger.error(`authz outbox install FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
          throw new Error(`authz outbox install failed in remote mode (no change feed): ${msg}`);
        }
        this.logger.warn(`authz outbox install attempt ${attempt} failed (Docmost tables not ready?): ${msg}`);
        await new Promise((r) => {
          const t = setTimeout(r, this.retryMs);
          t.unref?.();
        });
      }
    }
  }

  /** The idempotent DDL, serialized across replicas/processes by a transaction-scoped advisory lock. */
  private async install(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${INSTALL_LOCK_KEY})`.execute(trx);

      // The outbox table. `processed_at`/`attempts`/`error` are the LEGACY platform-consumer columns, kept
      // for old-platform compatibility during the rollout; the new platform consumer uses its OWN cursor.
      await sql`
        create table if not exists authz_outbox (
          id           bigserial primary key,
          op           text        not null,
          table_name   text        not null,
          payload      jsonb       not null,
          created_at   timestamptz not null default now(),
          processed_at timestamptz,
          error        text,
          attempts     integer     not null default 0
        );
        alter table authz_outbox add column if not exists attempts integer not null default 0;
        create index if not exists authz_outbox_unprocessed_idx on authz_outbox (id) where processed_at is null;
        create index if not exists authz_outbox_created_at_idx on authz_outbox (created_at);
      `.execute(trx);

      // The capture function. Stores ONLY the authz-relevant columns per table (jsonb_build_object, never the
      // full row) so large columns like pages.content/ydoc never land in the retained outbox. Enriches
      // page_permissions with page_id (resolved while the RI cascade still leaves page_access visible). Same
      // NOTIFY channel as the platform's legacy trigger (old-platform LISTEN still wakes; the fork's own
      // change-feed LISTEN also wakes).
      await sql`
        create or replace function authz_outbox_capture() returns trigger as $$
        declare full_row jsonb; rec jsonb;
        begin
          full_row := to_jsonb(case when tg_op = 'DELETE' then OLD else NEW end);
          if (tg_table_name = 'spaces') then
            rec := jsonb_build_object('id', full_row->'id', 'workspace_id', full_row->'workspace_id', 'deleted_at', full_row->'deleted_at');
          elsif (tg_table_name = 'space_members') then
            rec := jsonb_build_object('space_id', full_row->'space_id', 'user_id', full_row->'user_id', 'group_id', full_row->'group_id', 'role', full_row->'role', 'deleted_at', full_row->'deleted_at');
          elsif (tg_table_name = 'group_users') then
            rec := jsonb_build_object('group_id', full_row->'group_id', 'user_id', full_row->'user_id');
          elsif (tg_table_name = 'pages') then
            rec := jsonb_build_object('id', full_row->'id', 'space_id', full_row->'space_id', 'parent_page_id', full_row->'parent_page_id', 'deleted_at', full_row->'deleted_at');
          elsif (tg_table_name = 'page_access') then
            rec := jsonb_build_object('page_id', full_row->'page_id');
          elsif (tg_table_name = 'page_permissions') then
            rec := jsonb_build_object(
              'page_access_id', full_row->'page_access_id', 'user_id', full_row->'user_id',
              'group_id', full_row->'group_id', 'role', full_row->'role',
              'page_id', (select pa.page_id from page_access pa where pa.id = (full_row->>'page_access_id')::uuid)
            );
          else
            rec := full_row;
          end if;
          insert into authz_outbox (op, table_name, payload) values (tg_op, tg_table_name, rec);
          perform pg_notify('authz_outbox', '');
          return null;
        end; $$ language plpgsql;
      `.execute(trx);

      // Membership + page-restriction tables: full row triggers (a role change is an UPDATE).
      for (const table of ['space_members', 'group_users', 'page_access', 'page_permissions']) {
        await sql`
          drop trigger if exists authz_outbox_${sql.raw(table)} on ${sql.raw(table)};
          create trigger authz_outbox_${sql.raw(table)}
            after insert or update or delete on ${sql.raw(table)}
            for each row execute function authz_outbox_capture();
        `.execute(trx);
      }

      // Pages: structural edges (space + parent) + soft-delete transitions only — a title/content edit must
      // NOT churn SpiceDB. Fire on space_id, parent_page_id, deleted_at (a trash/restore is structural).
      await sql`
        drop trigger if exists authz_outbox_pages on pages;
        create trigger authz_outbox_pages
          after insert or delete or update of space_id, parent_page_id, deleted_at on pages
          for each row execute function authz_outbox_capture();
      `.execute(trx);

      // Spaces: the space->workspace connective edge (workspace_id) + soft-delete only. NB: deliberately NO
      // trigger on `users` — platform-admin is granted by the platform's control plane, never Docmost roles.
      await sql`
        drop trigger if exists authz_outbox_users on users;
        drop trigger if exists authz_outbox_spaces on spaces;
        create trigger authz_outbox_spaces
          after insert or delete or update of workspace_id, deleted_at on spaces
          for each row execute function authz_outbox_capture();
      `.execute(trx);
    });
  }
}
