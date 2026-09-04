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

/** Advisory-lock key so concurrent main-API replicas serialize the DDL (no DROP/CREATE-trigger race). */
const INSTALL_LOCK_KEY = 774615092310;
/** Bounded retry for the TRANSIENT "Docmost's own migrations have not created the tables yet" case. Module
 *  init order does NOT guarantee migrations ran before this bootstrap (DatabaseModule imports AuthzModule),
 *  so wait, then FAIL the boot rather than run without CDC. */
const MAX_ATTEMPTS = 30;
const RETRY_MS = 2000;

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
 * ENRICHES `page_permissions` rows with `page_id` at trigger time (resolved from `page_access` while the RI
 * cascade still leaves it visible), so the change feed never needs a live `page_access` lookup.
 *
 * Design choices:
 *  - A boot installer, NOT a Kysely migration: it runs uniformly in dev + prod (auto-migrate is prod-only),
 *    is GATED on remote mode (native standalone Docmost installs NO CCC DDL), and lives entirely in the
 *    excluded `service-bridge/` prefix (zero upstream-file edits).
 *  - Idempotent + advisory-locked: safe to run on every boot and on every replica.
 *  - Superset-compatible with the platform's LEGACY `authz_outbox` (keeps `processed_at`/`attempts`/`error`
 *    + the `authz_outbox` NOTIFY channel) so the OLD platform still drains it during the rollout window.
 *  - FAIL-CLOSED in remote: if the table + triggers cannot be established after the bounded retry, it THROWS
 *    (Nest aborts boot -> the container crashes + alarms) rather than run without CDC (a silent authorization
 *    drift). The internal LISTEN is a latency optimization owned by the feed service and is best-effort (the
 *    backstop poll is the correctness path), consistent with "the durable outbox is the source of truth".
 *  - Runs in the MAIN API only (the collab server does not import service-bridge) — no dueling installer.
 */
@Injectable()
export class AuthzOutboxInstaller implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthzOutboxInstaller.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'remote') {
      this.logger.log('AUTHZ_MODE is not remote — skipping authz outbox install (no CCC CDC in native)');
      return;
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.install();
        this.logger.log('authz_outbox table + capture trigger ensured on Docmost DB (remote mode)');
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === MAX_ATTEMPTS) {
          // Fail-closed: in remote mode a missing feed = silent authorization drift. Crash the boot.
          this.logger.error(`authz outbox install FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
          throw new Error(`authz outbox install failed in remote mode (no change feed): ${msg}`);
        }
        this.logger.warn(`authz outbox install attempt ${attempt} failed (Docmost tables not ready?): ${msg}`);
        await new Promise((r) => {
          const t = setTimeout(r, RETRY_MS);
          t.unref?.();
        });
      }
    }
  }

  /** The idempotent DDL, serialized across replicas by a transaction-scoped advisory lock. */
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

      // The capture function. Enriches page_permissions with page_id (resolved while the RI cascade still
      // leaves page_access visible). Same NOTIFY channel as the platform's legacy trigger (old-platform LISTEN
      // still wakes; the fork's own change-feed LISTEN also wakes).
      await sql`
        create or replace function authz_outbox_capture() returns trigger as $$
        declare rec jsonb;
        begin
          if (tg_op = 'DELETE') then rec := to_jsonb(OLD); else rec := to_jsonb(NEW); end if;
          if (tg_table_name = 'page_permissions') then
            rec := rec || jsonb_build_object(
              'page_id', (select pa.page_id from page_access pa where pa.id = (rec->>'page_access_id')::uuid)
            );
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
