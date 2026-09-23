import { PageRestrictionGuardInstaller, PAGE_RESTRICTION_GUARD_VERSION } from './page-restriction-guard.installer';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

/**
 * The page restriction guard installer's BOOT contract (#493/#545): mode-gated, no DDL when already current,
 * advisory-locked, bounded by `lock_timeout` on a live table, retried, and FAIL-CLOSED in remote — a remote boot
 * that cannot establish the guards must refuse to start, or native move-to-space deletes restrictions in the
 * database again (#493 G2). The triggers' SQL behaviour is proven on a real Postgres in
 * `page-restriction-guard.pg.spec.ts`.
 */
describe('PageRestrictionGuardInstaller', () => {
  const ENV = ['PAGE_RESTRICTION_GUARD_INSTALL_MAX_ATTEMPTS', 'PAGE_RESTRICTION_GUARD_INSTALL_RETRY_MS'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    ENV.forEach((k) => (saved[k] = process.env[k]));
    process.env.PAGE_RESTRICTION_GUARD_INSTALL_RETRY_MS = '0';
  });
  afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

  const isCurrentQuery = (q: SpyQuery) => q.sql.includes('obj_description');
  const boot = (spy: ReturnType<typeof spyKysely>, mode = 'remote') =>
    new PageRestrictionGuardInstaller(spy.db, mode as any).onApplicationBootstrap();

  it('installs NOTHING in native mode', async () => {
    const spy = spyKysely(() => []);
    await boot(spy, 'native');
    expect(spy.calls).toHaveLength(0);
    expect(spy.tx).toEqual([]);
  });

  it('runs NO DDL when the installed guard is current (version stamp + both triggers enabled)', async () => {
    const spy = spyKysely((q) => (isCurrentQuery(q) ? [{ current: true }] : []));
    await boot(spy);
    expect(spy.tx).toEqual([]);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].parameters).toContain(PAGE_RESTRICTION_GUARD_VERSION);
  });

  it('installs both guards in ONE advisory-locked transaction, bounded by lock_timeout BEFORE any DDL', async () => {
    const spy = spyKysely(() => []);
    await boot(spy);

    expect(spy.tx).toEqual(['begin', 'commit']);
    const sqls = spy.calls.map((c) => c.sql);
    const at = (needle: string) => sqls.findIndex((s) => s.includes(needle));
    expect(spy.calls[at('pg_advisory_xact_lock')].parameters).toEqual([545545001]); // DDL serialized across replicas
    expect(at("set local lock_timeout = '3s'")).toBeGreaterThan(at('pg_advisory_xact_lock'));
    expect(at("set local lock_timeout = '3s'")).toBeLessThan(at('create or replace function'));
    const all = sqls.join('\n');
    // g1 fires on every row an UPDATE sets space_id on (changed or not); g2 only on a parent change.
    expect(all).toContain("before update of space_id on pages\nfor each row execute function ccc_page_restriction_guard('space')");
    expect(all).toContain("before update of parent_page_id on pages\nfor each row execute function ccc_page_restriction_guard('parent')");
    expect(all).toContain('before insert or update on page_access');
    // Same table-lock order as AuthzOutboxInstaller (page_access, then pages): the two boot concurrently.
    expect(at('create trigger ccc_page_access_guard')).toBeLessThan(at('drop trigger if exists ccc_page_restriction_guard'));
    // Every function is stamped, so the next boot's isCurrent() skips the DDL.
    expect(all.match(new RegExp(`is '${PAGE_RESTRICTION_GUARD_VERSION}'`, 'g'))).toHaveLength(3);
  });

  it('RETRIES after a lock_timeout on the live table, then succeeds', async () => {
    process.env.PAGE_RESTRICTION_GUARD_INSTALL_MAX_ATTEMPTS = '5';
    let failedOnce = false;
    const spy = spyKysely((q) => {
      if (!failedOnce && q.sql.includes('create trigger ccc_page_restriction_guard')) {
        failedOnce = true;
        throw new Error('canceling statement due to lock timeout');
      }
      return [];
    });
    await expect(boot(spy)).resolves.toBeUndefined();
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'commit']);
  });

  it('REFUSES TO BOOT (fail-closed) in remote when the install never succeeds', async () => {
    process.env.PAGE_RESTRICTION_GUARD_INSTALL_MAX_ATTEMPTS = '2';
    const spy = spyKysely((q) => {
      if (isCurrentQuery(q)) return [];
      throw new Error('permission denied for table pages');
    });
    await expect(boot(spy)).rejects.toThrow(/page restriction guard install failed in remote mode/);
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'rollback']); // both attempts, both rolled back
  });
});
