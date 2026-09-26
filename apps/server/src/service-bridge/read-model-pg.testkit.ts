import * as postgres from 'postgres';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';

/**
 * Shared real-Postgres harness for the read-model service-bridge pg specs (issue #174 remainder): the
 * content keyset read model, the space control-plane reads, and the workspace-settings JSONB merge. It
 * mirrors the production Kysely config the installer/retention pg specs already use (postgres.js +
 * PostgresJSDialect + CamelCasePlugin + the bigint->number parser), so a raw-sql read comes back with the
 * SAME camelCased result keys the services rely on. Each spec owns a private schema (search_path) so the
 * pg specs share one database under `--runInBand`.
 *
 * NOT a jest suite: the `.testkit.ts` suffix keeps it out of the runtime image (tsconfig.build.json) and out
 * of the jest testRegex (only `*.spec.ts` is collected), exactly like `kysely-spy.testkit.ts`.
 */
export const PG_URL = process.env.AUTHZ_TEST_PG_URL;

/** A stable, ordered uuid: `id::text` sorts by `n`, so keyset tiebreak ordering is predictable in tests. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A deterministic `WorkspaceResolver` stand-in. The single-tenant resolution logic is its own concern
 * (proven elsewhere); these specs pin the DOWNSTREAM query behaviour, so a fixed default workspace id keeps
 * the confidentiality assertions (a supplied id in a FOREIGN workspace is excluded) unambiguous.
 */
export const fakeWorkspaceResolver = (workspaceId: string) =>
  ({ resolveDefaultWorkspaceId: async () => workspaceId }) as unknown as any;

/** A postgres.js pool pinned to `schema`, with the same bigint->number parser as production Kysely. The
 *  custom `types` narrows postgres.js's inferred generic; cast back to the plain `postgres.Sql` the callers
 *  use (the same widening the sibling authz-outbox pg specs do inline). */
export const mkReadModelPg = (schema: string, max: number): postgres.Sql =>
  postgres(PG_URL as string, {
    max,
    onnotice: () => {},
    connection: { search_path: schema },
    types: {
      bigint: {
        to: 20,
        from: [20, 1700],
        serialize: (v: number) => v.toString(),
        parse: (v: string) => Number.parseInt(v),
      },
    },
  }) as unknown as postgres.Sql;

/** Drop+recreate the private schema on a throwaway connection (call once in beforeAll). */
export const bootstrapSchema = async (schema: string): Promise<void> => {
  const b = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
  await b`drop schema if exists ${b(schema)} cascade`;
  await b`create schema ${b(schema)}`;
  await b.end({ timeout: 5 });
};

/** Kysely over the app pool with the production plugin set (CamelCasePlugin), what the services run on. */
export const mkReadModelDb = (appPg: postgres.Sql): Kysely<any> =>
  new Kysely<any>({
    dialect: new PostgresJSDialect({ postgres: appPg }),
    plugins: [new CamelCasePlugin()],
  });

/**
 * The base tables the read-model queries select from and filter on, faithful to the Docmost migrations for
 * the columns these `sql` templates touch (`workspace_id`, `deleted_at`, `is_personal`, the keyset columns,
 * the settings jsonb). `gen_random_uuid()` stands in for Docmost's `gen_uuid_v7()`; ordering in the specs is
 * driven by explicit ids, not insertion order, so the uuid version is irrelevant.
 */
export const createReadModelTables = async (pg: postgres.Sql): Promise<void> => {
  await pg`
    create table workspaces (
      id uuid primary key, name varchar, settings jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`;
  await pg`
    create table spaces (
      id uuid primary key, name varchar, slug varchar, description varchar,
      visibility varchar not null default 'private', is_personal boolean not null default false,
      workspace_id uuid not null, creator_id uuid, settings jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`;
  await pg`
    create table space_members (
      id uuid primary key default gen_random_uuid(), user_id uuid, group_id uuid, space_id uuid not null,
      role varchar not null, added_by_id uuid,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`;
  await pg`
    create table pages (
      id uuid primary key, slug_id varchar, title varchar, icon varchar, position varchar,
      space_id uuid not null, parent_page_id uuid, workspace_id uuid not null,
      creator_id uuid, last_updated_by_id uuid,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`;
  await pg`
    create table page_access (
      id uuid primary key default gen_random_uuid(), page_id uuid not null, workspace_id uuid not null
    )`;
  await pg`
    create table page_permissions (
      id uuid primary key default gen_random_uuid(), page_access_id uuid not null,
      user_id uuid, group_id uuid, role varchar not null, created_at timestamptz not null default now()
    )`;
};

/**
 * #615: the tables the knowledge reads join beyond the base set — page creator/editor names (`users`), labels,
 * links, edits (`page_history`), comments, attachments and Docmost's `audit` log — faithful to the Docmost
 * migrations for the columns those reads touch. OPT-IN (not part of `createReadModelTables`) because several pg
 * specs create their own `users` table next to the base set; a spec that lists pages calls both.
 */
export const createKnowledgeTables = async (pg: postgres.Sql): Promise<void> => {
  await pg`
    create table users (
      id uuid primary key, name varchar, email varchar, workspace_id uuid,
      created_at timestamptz not null default now(), deleted_at timestamptz
    )`;
  await pg`
    create table labels (
      id uuid primary key default gen_random_uuid(), name varchar not null,
      type varchar not null default 'page', workspace_id uuid not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (workspace_id, type, name)
    )`;
  await pg`
    create table page_labels (
      id uuid primary key default gen_random_uuid(), page_id uuid not null, label_id uuid not null,
      created_at timestamptz not null default now(), unique (page_id, label_id)
    )`;
  await pg`
    create table backlinks (
      id uuid primary key default gen_random_uuid(), source_page_id uuid not null, target_page_id uuid not null,
      workspace_id uuid not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (source_page_id, target_page_id)
    )`;
  await pg`
    create table page_history (
      id uuid primary key default gen_random_uuid(), page_id uuid not null, title varchar,
      last_updated_by_id uuid, space_id uuid not null, workspace_id uuid not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`;
  await pg`
    create table comments (
      id uuid primary key default gen_random_uuid(), content jsonb, selection varchar, type varchar,
      creator_id uuid, page_id uuid not null, parent_comment_id uuid, workspace_id uuid not null,
      space_id uuid, resolved_at timestamptz, resolved_by_id uuid,
      created_at timestamptz not null default now(), edited_at timestamptz, deleted_at timestamptz
    )`;
  await pg`
    create table attachments (
      id uuid primary key default gen_random_uuid(), file_name varchar not null default 'f',
      file_path varchar not null default 'p', file_ext varchar not null default '.txt', type varchar,
      creator_id uuid not null, page_id uuid, space_id uuid, workspace_id uuid not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`;
  await pg`
    create table audit (
      id uuid primary key default gen_random_uuid(), workspace_id uuid not null, actor_id uuid,
      actor_type varchar not null default 'user', event varchar not null, resource_type varchar not null,
      resource_id uuid, space_id uuid, changes jsonb, metadata jsonb, ip_address inet,
      created_at timestamptz not null default now()
    )`;
};
