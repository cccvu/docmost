import * as postgres from 'postgres';
import { createReadModelTables } from '../../service-bridge/read-model-pg.testkit';

/**
 * Real-Postgres fixtures for the share lifecycle pg specs (#660, #335): the read-model base tables plus `users`,
 * `group_users` and `shares`, faithful to the Docmost migrations for the columns `ShareRepo` / `PdpShareRepo`
 * touch (`shares` exactly as `20250408T191830-shares.ts` creates it, so `ccc_share_expiry`'s foreign key and the
 * page cascade behave as in production). NOT a jest suite (the `.testkit.ts` suffix keeps it out of the jest regex
 * and the runtime image).
 */
export const createShareTables = async (pg: postgres.Sql): Promise<void> => {
  await createReadModelTables(pg);
  await pg`
    create table users (
      id uuid primary key, name varchar, email varchar, avatar_url varchar, workspace_id uuid,
      created_at timestamptz not null default now(), deleted_at timestamptz
    )`;
  await pg`
    create table group_users (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null
    )`;
  await pg`
    create table shares (
      id uuid primary key default gen_random_uuid(),
      key varchar not null,
      page_id uuid references pages(id) on delete cascade,
      include_sub_pages boolean default false,
      search_indexing boolean default false,
      creator_id uuid,
      space_id uuid not null,
      workspace_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint shares_key_workspace_id_unique unique (key, workspace_id)
    )`;
};
