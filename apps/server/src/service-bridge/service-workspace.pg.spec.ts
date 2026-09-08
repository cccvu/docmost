import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
import { ServiceWorkspaceService } from './service-workspace.service';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from './read-model-pg.testkit';

/**
 * Real-Postgres proof of the workspace-settings JSONB shallow-merge (issue #174 remainder, item 4). The unit
 * spec (`service-workspace.service.spec.ts`) only string-matches `coalesce(settings, '{}') || jsonb_build_object(...)`
 * on the compiled SQL via the Kysely spy; it seeds a fixture with a sibling key but never round-trips the
 * merge through Postgres. This spec writes a real settings object and reads it back to prove sibling keys
 * SURVIVE the update (a plain `= jsonb_build_object(...)` assignment would drop them).
 *
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG workspace-settings gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'service_workspace_pg_spec';
const WS_ID = uuid(100);

d('ServiceWorkspaceService.updateSettings JSONB merge on real Postgres', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceWorkspaceService;

  const readSettings = async (): Promise<Record<string, unknown>> => {
    const rows = await pg<{ settings: Record<string, unknown> }[]>`select settings from workspaces where id = ${WS_ID}`;
    return rows[0].settings;
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    svc = new ServiceWorkspaceService(db as any, fakeWorkspaceResolver(WS_ID));
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    // A real settings object with a sibling key AND a nested object that the merge must not disturb.
    await pg`truncate workspaces`;
    await pg`
      insert into workspaces (id, name, settings, created_at, deleted_at)
      values (${WS_ID}, 'CCC Wiki', ${pg.json({ defaultPageEditMode: 'edit', other: 'keep-me', nested: { a: 1 } })}, now(), null)`;
  });

  it('changing defaultPageEditMode preserves sibling keys (the shallow-merge round-trip)', async () => {
    const view = await svc.updateSettings({ defaultPageEditMode: 'read' } as any);
    expect(view).toEqual({ name: 'CCC Wiki', defaultPageEditMode: 'read' });

    const settings = await readSettings();
    expect(settings.defaultPageEditMode).toBe('read'); // the changed key
    expect(settings.other).toBe('keep-me'); // the sibling key SURVIVES the merge
    expect(settings.nested).toEqual({ a: 1 }); // and a nested sibling too
  });

  it('a name-only update leaves the entire settings object untouched', async () => {
    const view = await svc.updateSettings({ name: 'Renamed' } as any);
    expect(view).toEqual({ name: 'Renamed', defaultPageEditMode: 'edit' });

    const settings = await readSettings();
    expect(settings).toEqual({ defaultPageEditMode: 'edit', other: 'keep-me', nested: { a: 1 } });
  });

  it('a combined name + mode update commits both and still preserves siblings', async () => {
    const view = await svc.updateSettings({ name: 'Both', defaultPageEditMode: 'read' } as any);
    expect(view).toEqual({ name: 'Both', defaultPageEditMode: 'read' });

    const settings = await readSettings();
    expect(settings.other).toBe('keep-me');
    expect(settings.defaultPageEditMode).toBe('read');
  });

  it('404s when the workspace row is soft-deleted (the deleted_at guard on the write)', async () => {
    await pg`update workspaces set deleted_at = now() where id = ${WS_ID}`;
    await expect(svc.updateSettings({ defaultPageEditMode: 'read' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a no-op update (neither field set) returns the current view and issues no write', async () => {
    const before = await readSettings();
    const view = await svc.updateSettings({} as any);
    expect(view).toEqual({ name: 'CCC Wiki', defaultPageEditMode: 'edit' });
    expect(await readSettings()).toEqual(before); // the settings jsonb is untouched (short-circuits to getSettings)
  });

  it('getSettings normalizes an unknown defaultPageEditMode to null in the view while preserving the stored value', async () => {
    await pg`update workspaces set settings = ${pg.json({ defaultPageEditMode: 'weird', other: 'keep-me' })} where id = ${WS_ID}`;
    const view = await svc.getSettings();
    expect(view.defaultPageEditMode).toBeNull(); // only 'read' | 'edit' pass the view guard
    expect((await readSettings()).defaultPageEditMode).toBe('weird'); // the raw jsonb is not rewritten
  });
});
