import { AuthzOutboxInstaller } from './authz-outbox.installer';
import { spyKysely } from './kysely-spy.testkit';

/**
 * The fork-owned outbox installer (Group D, #171): mode-gated, advisory-locked, idempotent, column-scoped
 * capture, and FAIL-CLOSED in remote. In native it must install NO CCC DDL (the standalone story); in remote
 * it installs the table + capture function + AFTER triggers in one advisory-locked transaction, retries the
 * transient "tables not ready" case, and crashes the boot if it never succeeds.
 */
describe('AuthzOutboxInstaller', () => {
  const ENV = ['AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS', 'AUTHZ_OUTBOX_INSTALL_RETRY_MS'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => ENV.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() =>
    ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))),
  );

  it('installs NOTHING in native mode', async () => {
    const spy = spyKysely(() => []);
    const installer = new AuthzOutboxInstaller(spy.db, 'native' as any);
    await installer.onApplicationBootstrap();
    expect(spy.calls).toHaveLength(0);
    expect(spy.tx).toEqual([]);
  });

  it('installs a column-scoped outbox + capture trigger inside one advisory-locked transaction in remote', async () => {
    const spy = spyKysely(() => []);
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await installer.onApplicationBootstrap();

    expect(spy.tx).toEqual(['begin', 'commit']); // one transaction, committed
    const all = spy.calls.map((c) => c.sql).join('\n');
    expect(all).toContain('pg_advisory_xact_lock'); // serialized across replicas/processes
    expect(all).toContain('create table if not exists authz_outbox');
    expect(all).toContain('authz_outbox_capture'); // the capture function
    // Column-scoped capture (data minimization — never store full rows / pages.content|ydoc).
    expect(all).toContain('jsonb_build_object');
    expect(all).toContain("full_row->'space_id'");
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

  it('FAILS the boot (fail-closed) in remote when the DDL never succeeds', async () => {
    process.env.AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS = '2';
    process.env.AUTHZ_OUTBOX_INSTALL_RETRY_MS = '0';
    const spy = spyKysely(() => {
      throw new Error('relation "space_members" does not exist');
    });
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await expect(installer.onApplicationBootstrap()).rejects.toThrow(/no change feed/);
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'rollback']); // both attempts rolled back
  });

  it('RETRIES the transient "tables not ready" case then succeeds', async () => {
    process.env.AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS = '5';
    process.env.AUTHZ_OUTBOX_INSTALL_RETRY_MS = '0';
    let call = 0;
    const spy = spyKysely(() => {
      call += 1;
      if (call === 1) throw new Error('relation "space_members" does not exist'); // first attempt fails
      return [];
    });
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await expect(installer.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'commit']); // failed once, then committed
  });
});
