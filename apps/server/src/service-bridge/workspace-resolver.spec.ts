import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { WorkspaceResolver } from './workspace-resolver';
import { spyKysely } from './kysely-spy.testkit';

describe('WorkspaceResolver.resolveDefaultWorkspaceId (canonical single-tenant workspace)', () => {
  it('selects the OLDEST non-deleted workspace (deterministic: order by created_at asc, id asc)', async () => {
    // The query itself pins determinism: order by created_at asc THEN id asc (F4 tiebreak) means the DB
    // returns exactly the oldest, and rows created in the same instant no longer resolve non-deterministically.
    const { resolver, spy } = makeResolver([{ id: 'ws-oldest' }]);
    await expect(resolver.resolveDefaultWorkspaceId()).resolves.toBe('ws-oldest');
    const sql = spy.calls[0].sql.toLowerCase();
    expect(sql).toContain('order by');
    expect(sql).toContain('created_at');
    expect(sql).toContain('asc');
    expect(sql).toContain('limit');
    expect(sql).toContain('deleted_at'); // excludes soft-deleted workspaces
    expect(sql).toMatch(/order by .*created_at.* asc, .*id.* asc/); // F4: deterministic secondary tiebreak
  });

  it('503s when NO workspace is provisioned (never a silent wrong workspace)', async () => {
    const { resolver } = makeResolver([]);
    await expect(resolver.resolveDefaultWorkspaceId()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // F4 (companion #272): more than one non-deleted workspace breaches the single-tenant invariant. The
  // resolver must still return a DETERMINISTIC answer (the oldest) — never flip between calls — and must
  // WARN so the anomaly is visible, but must NOT hard-fail (that would take the whole east-west surface down
  // over an accidental second workspace).
  it('F4: with >1 non-deleted workspace, returns the oldest deterministically and WARNs (no hard-fail)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { resolver } = makeResolver([{ id: 'ws-oldest' }, { id: 'ws-second' }]);
      await expect(resolver.resolveDefaultWorkspaceId()).resolves.toBe('ws-oldest');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/single-tenant invariant/i);
    } finally {
      warn.mockRestore();
    }
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

  // F5 (companion #272): a soft-deleted user must not anchor a PDP grant — the lookup filters them out.
  it('F5: excludes soft-deleted users (query filters deleted_at is null)', async () => {
    const spy = spyKysely(() => [{ workspace_id: 'ws1' }]);
    const r = new WorkspaceResolver(spy.db);
    await r.resolveUserWorkspaceId('user-42');
    expect(spy.calls[0].sql.toLowerCase()).toContain('deleted_at is null');
  });

  // F5: a row with a NULL workspace_id (the column is nullable) must 404, never return null typed as string
  // (a bogus PDP anchor is worse than a clean not-found).
  it('F5: 404s a user whose workspace_id is null (no null-as-string anchor)', async () => {
    const spy = spyKysely(() => [{ workspace_id: null }]);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUserWorkspaceId('ghost-ws')).rejects.toBeInstanceOf(NotFoundException);
  });
});

// Small helper so a test can grab both the resolver and its spy.
function makeResolver(rows: unknown[]) {
  const spy = spyKysely(() => rows);
  return { resolver: new WorkspaceResolver(spy.db), spy };
}
