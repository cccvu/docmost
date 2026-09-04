import { AuthzOutboxInstaller } from './authz-outbox.installer';
import { spyKysely } from './kysely-spy.testkit';

/**
 * The fork-owned outbox installer (Group D, #171): mode-gated, advisory-locked, idempotent DDL. In native it
 * must install NO CCC DDL (the standalone story); in remote it installs the table + capture function (with the
 * page_id enrichment) + the AFTER triggers, inside one advisory-locked transaction.
 */
describe('AuthzOutboxInstaller', () => {
  it('installs NOTHING in native mode', async () => {
    const spy = spyKysely(() => []);
    const installer = new AuthzOutboxInstaller(spy.db, 'native' as any);
    await installer.onApplicationBootstrap();
    expect(spy.calls).toHaveLength(0);
    expect(spy.tx).toEqual([]);
  });

  it('installs the outbox table + capture trigger inside one advisory-locked transaction in remote mode', async () => {
    const spy = spyKysely(() => []);
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await installer.onApplicationBootstrap();

    expect(spy.tx).toEqual(['begin', 'commit']); // one transaction, committed
    const all = spy.calls.map((c) => c.sql).join('\n');
    expect(all).toContain('pg_advisory_xact_lock'); // serialized across replicas
    expect(all).toContain('create table if not exists authz_outbox');
    expect(all).toContain('authz_outbox_capture'); // the capture function
    expect(all).toContain('page_id'); // page_permissions payload enrichment
    expect(all).toContain('pg_notify'); // wakeup channel preserved (old-platform LISTEN compat)
    // AFTER triggers on every watched table.
    for (const t of ['space_members', 'group_users', 'page_access', 'page_permissions', 'pages', 'spaces']) {
      expect(all).toContain(`authz_outbox_${t}`);
    }
    // Deliberately NO trigger on users (platform-admin is not derived from Docmost roles).
    expect(all).toContain('drop trigger if exists authz_outbox_users on users');
    expect(all).not.toContain('create trigger authz_outbox_users');
  });
});
