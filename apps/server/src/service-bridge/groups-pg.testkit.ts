import * as postgres from 'postgres';
import { createReadModelTables } from './read-model-pg.testkit';

/**
 * wiki-v2 #797: the schema the group control plane and the group branch of a space add run on, for their real-Postgres
 * specs: the read-model base tables plus `users`, `groups`, `group_users`, the `space_members` unique keys the upserts
 * name, and the foreign keys whose behaviour the invariants rely on (`group_users` / `space_members` /
 * `page_permissions` → `groups` ON DELETE CASCADE, `space_members.space_id` → `spaces`), faithful to
 * 20240324T085700-groups.ts, 20240324T085900-spaces.ts and 20260224T233803-page-permissions.ts for the columns touched.
 *
 * DDL only: the row fixtures live in each spec, because the fork-boundary fitness scans read every non-spec file
 * (a fixture insert here would read as a new write path).
 *
 * NOT a jest suite (the `.testkit.ts` suffix keeps it out of the runtime image and the jest testRegex).
 */
export const createGroupTables = async (pg: postgres.Sql): Promise<void> => {
  await createReadModelTables(pg);
  await pg`
    create table users (
      id uuid primary key default gen_random_uuid(), name varchar, email varchar not null,
      email_verified_at timestamptz, password varchar, avatar_url varchar, role varchar, workspace_id uuid,
      locale varchar, timezone varchar, settings jsonb, last_login_at timestamptz, deactivated_at timestamptz,
      has_generated_password boolean default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint users_email_workspace_id_unique unique (email, workspace_id)
    )`;
  await pg`
    create table groups (
      id uuid primary key default gen_random_uuid(), name varchar not null, description text,
      is_default boolean not null, workspace_id uuid not null, creator_id uuid references users(id),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint groups_name_workspace_id_unique unique (name, workspace_id)
    )`;
  await pg`
    create table group_users (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      group_id uuid not null references groups(id) on delete cascade,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      constraint group_users_group_id_user_id_unique unique (group_id, user_id)
    )`;
  await pg`alter table space_members add constraint space_members_space_id_user_id_unique unique (space_id, user_id)`;
  await pg`alter table space_members add constraint space_members_space_id_group_id_unique unique (space_id, group_id)`;
  await pg`alter table space_members add constraint space_members_group_fk foreign key (group_id) references groups(id) on delete cascade`;
  await pg`alter table space_members add constraint space_members_space_fk foreign key (space_id) references spaces(id) on delete cascade`;
  await pg`alter table page_permissions add constraint page_permissions_group_fk foreign key (group_id) references groups(id) on delete cascade`;
};

/** Wipe every row (FK order). */
export const truncateGroupTables = async (pg: postgres.Sql): Promise<void> => {
  await pg`truncate page_permissions, page_access, space_members, group_users, groups, pages, spaces, users`;
};
