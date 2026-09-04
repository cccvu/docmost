import { NotFoundException } from '@nestjs/common';
import { ServiceWorkspaceService } from './service-workspace.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

const workspaces = () => ({ resolveDefaultWorkspaceId: jest.fn(async () => 'ws1') }) as any;
const make = (respond: (q: SpyQuery) => unknown[]) => {
  const spy = spyKysely(respond);
  return { svc: new ServiceWorkspaceService(spy.db, workspaces()), spy };
};
const q = (s: string) => s.toLowerCase();
const row = (over: Partial<{ name: string | null; settings: unknown }> = {}) => ({
  name: 'CCC Wiki',
  settings: { defaultPageEditMode: 'edit', other: 'keep-me' },
  ...over,
});

/**
 * Guards the workspace-settings write that Phase C moved from the platform into the fork. The
 * highest-risk property is the JSONB SHALLOW-MERGE: a regression to a plain `settings = jsonb_build_object(...)`
 * assignment would silently wipe sibling keys with green CI. Before this spec that merge had NO test in
 * EITHER repo (the platform docstring wrongly claimed fork coverage). Asserted against the REAL compiled SQL
 * via the spy Kysely (same Postgres compiler + CamelCasePlugin as production).
 */
describe('ServiceWorkspaceService — workspace settings (JSONB shallow-merge preserved)', () => {
  it('getSettings normalises the mode and 404s a missing workspace', async () => {
    const ok = make(() => [row()]);
    expect(await ok.svc.getSettings()).toEqual({ name: 'CCC Wiki', defaultPageEditMode: 'edit' });

    const unknownMode = make(() => [row({ settings: { defaultPageEditMode: 'bogus' } })]);
    expect((await unknownMode.svc.getSettings()).defaultPageEditMode).toBeNull();

    const gone = make(() => []);
    await expect(gone.svc.getSettings()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updating defaultPageEditMode uses a coalesce + || shallow-merge, NOT a clobbering assignment', async () => {
    const { svc, spy } = make(() => [row()]);
    await svc.updateSettings({ defaultPageEditMode: 'read' } as any);

    const sql = q(spy.calls[0].sql);
    // The sibling-key-preservation guarantee: merge onto the existing object, never replace it.
    expect(sql).toContain('coalesce(settings');
    expect(sql).toContain('|| jsonb_build_object(');
    expect(spy.calls[0].parameters).toContain('read');
  });

  it('updating only the name never touches the settings column', async () => {
    const { svc, spy } = make(() => [row({ name: 'Renamed' })]);
    await svc.updateSettings({ name: 'Renamed' } as any);

    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('name =');
    expect(sql).not.toContain('jsonb_build_object'); // settings untouched
    expect(sql).toContain('updated_at = now()');
  });

  it('updating both fields sets name AND merges settings in one statement', async () => {
    const { svc, spy } = make(() => [row()]);
    await svc.updateSettings({ name: 'Both', defaultPageEditMode: 'edit' } as any);

    expect(spy.calls).toHaveLength(1); // one atomic UPDATE, single round-trip
    const sql = q(spy.calls[0].sql);
    expect(sql).toContain('name =');
    expect(sql).toContain('|| jsonb_build_object(');
  });

  it('a no-op update issues no UPDATE (reads current state) and 404s a missing workspace', async () => {
    const { svc, spy } = make(() => [row()]);
    await svc.updateSettings({} as any);
    // Only the getSettings SELECT ran; no write was attempted.
    expect(spy.calls).toHaveLength(1);
    expect(q(spy.calls[0].sql)).toContain('select');
    expect(q(spy.calls[0].sql)).not.toContain('update');

    const gone = make(() => []);
    await expect(gone.svc.updateSettings({ name: 'x' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
