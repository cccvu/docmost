import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { WorkspaceResolver } from './workspace-resolver';
import { spyKysely } from './kysely-spy.testkit';

describe('WorkspaceResolver.resolveDefaultWorkspaceId (canonical single-tenant workspace)', () => {
  it('selects the OLDEST non-deleted workspace (deterministic: order by created_at asc, limit 1)', async () => {
    // With >1 workspace, the query itself pins determinism: order by created_at asc + limit 1 means the
    // DB returns exactly the oldest. The spy returns whatever the query would (the first/oldest row).
    const { resolver, spy } = makeResolver([{ id: 'ws-oldest' }]);
    await expect(resolver.resolveDefaultWorkspaceId()).resolves.toBe('ws-oldest');
    const sql = spy.calls[0].sql.toLowerCase();
    expect(sql).toContain('order by');
    expect(sql).toContain('created_at');
    expect(sql).toContain('asc');
    expect(sql).toContain('limit');
    expect(sql).toContain('deleted_at'); // excludes soft-deleted workspaces
  });

  it('503s when NO workspace is provisioned (never a silent wrong workspace)', async () => {
    const { resolver } = makeResolver([]);
    await expect(resolver.resolveDefaultWorkspaceId()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('WorkspaceResolver.resolveUserWorkspaceId', () => {
  it('returns the workspace of an existing user, binding the user id as a parameter', async () => {
    const spy = spyKysely(() => [{ workspace_id: 'ws1' }]);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUserWorkspaceId('user-42')).resolves.toBe('ws1');
    expect(spy.calls[0].sql.toLowerCase()).toContain('from users where id =');
    expect(spy.calls[0].parameters).toContain('user-42');
  });

  it('404s an unknown user id', async () => {
    const spy = spyKysely(() => []);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUserWorkspaceId('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

// Small helper so a test can grab both the resolver and its spy.
function makeResolver(rows: unknown[]) {
  const spy = spyKysely(() => rows);
  return { resolver: new WorkspaceResolver(spy.db), spy };
}
