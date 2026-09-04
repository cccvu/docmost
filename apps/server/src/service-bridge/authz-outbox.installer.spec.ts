import { AuthzOutboxInstaller, UnsupportedPgVersionError } from './authz-outbox.installer';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

/**
 * The fork-owned outbox installer (Group D, #171): mode-gated, advisory-locked, idempotent, column-scoped
 * capture, and FAIL-CLOSED in remote. R2 adds the commit-safe watermark DDL (the `xact_id xid8` column with a
 * `pg_current_xact_id()` default + the `authz_outbox_gc` high-water table) behind a PG 13+ version invariant
 * that fails the boot IMMEDIATELY (no retry) on a too-old engine.
 */
describe('AuthzOutboxInstaller', () => {
  const ENV = ['AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS', 'AUTHZ_OUTBOX_INSTALL_RETRY_MS'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => ENV.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() =>
    ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))),
  );

  /** A supported engine unless overridden: the version probe returns PG 18, everything else is a no-op. */
  const pg18 = (rest: (q: SpyQuery) => unknown[] = () => []) => (q: SpyQuery): unknown[] =>
    q.sql.includes('server_version_num') ? [{ v: 180000 }] : rest(q);

  it('installs NOTHING in native mode', async () => {
    const spy = spyKysely(() => []);
    const installer = new AuthzOutboxInstaller(spy.db, 'native' as any);
    await installer.onApplicationBootstrap();
    expect(spy.calls).toHaveLength(0);
    expect(spy.tx).toEqual([]);
  });

  it('installs the commit-safe outbox + capture trigger inside one advisory-locked transaction in remote', async () => {
    const spy = spyKysely(pg18());
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await installer.onApplicationBootstrap();

    expect(spy.tx).toEqual(['begin', 'commit']); // one transaction, committed
    const all = spy.calls.map((c) => c.sql).join('\n');
    expect(all).toContain('pg_advisory_xact_lock'); // serialized across replicas/processes
    expect(all).toContain('server_version_num'); // PG-version invariant probed before any DDL
    expect(all).toContain('create table if not exists authz_outbox');
    // R2 commit-safe watermark: the xact_id column (xid8, pg_current_xact_id default) + the (xact_id, id) index.
    expect(all).toContain('xact_id xid8');
    expect(all).toContain('pg_current_xact_id');
    expect(all).toContain('authz_outbox_xact_idx');
    // R2 stale-detection high-water table.
    expect(all).toContain('create table if not exists authz_outbox_gc');
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

  it('FAILS the boot IMMEDIATELY (no retry) on an unsupported PG version', async () => {
    process.env.AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS = '30';
    const spy = spyKysely((q) => (q.sql.includes('server_version_num') ? [{ v: 120000 }] : []));
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await expect(installer.onApplicationBootstrap()).rejects.toBeInstanceOf(UnsupportedPgVersionError);
    expect(spy.tx).toEqual(['begin', 'rollback']); // ONE attempt — the retry budget is not burned
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
    let failedOnce = false;
    const spy = spyKysely(
      pg18((q) => {
        if (!failedOnce && q.sql.includes('create table if not exists authz_outbox')) {
          failedOnce = true;
          throw new Error('relation "space_members" does not exist'); // first attempt: migrations not ready
        }
        return [];
      }),
    );
    const installer = new AuthzOutboxInstaller(spy.db, 'remote' as any);
    await expect(installer.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'commit']); // failed once, then committed
  });
});
