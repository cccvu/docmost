import { PageCycleGuardInstaller } from './page-cycle-guard.installer';
import { spyKysely } from './kysely-spy.testkit';

/**
 * The page cycle-guard installer's BOOT contract (#485): mode-gated, advisory-locked, retried while the engine's
 * tables are not ready, and FAIL-CLOSED in remote — a remote boot that cannot install the trigger must refuse to
 * start, or the concurrent-move race the trigger closes silently reopens. The trigger's SQL behaviour itself is
 * proven against a real Postgres in `service-page-lifecycle.pg.spec.ts`.
 */
describe('PageCycleGuardInstaller', () => {
  const ENV = [
    'PAGE_CYCLE_GUARD_INSTALL_MAX_ATTEMPTS',
    'PAGE_CYCLE_GUARD_INSTALL_RETRY_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => ENV.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() =>
    ENV.forEach((k) =>
      saved[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = saved[k]),
    ),
  );

  it('installs NOTHING in native mode', async () => {
    const spy = spyKysely(() => []);
    await new PageCycleGuardInstaller(
      spy.db,
      'native' as any,
    ).onApplicationBootstrap();
    expect(spy.calls).toHaveLength(0);
    expect(spy.tx).toEqual([]);
  });

  it('installs the guard function + BEFORE UPDATE OF parent_page_id trigger in ONE advisory-locked transaction', async () => {
    const spy = spyKysely(() => []);
    await new PageCycleGuardInstaller(
      spy.db,
      'remote' as any,
    ).onApplicationBootstrap();

    expect(spy.tx).toEqual(['begin', 'commit']);
    const all = spy.calls.map((c) => c.sql).join('\n');
    expect(all).toContain('pg_advisory_xact_lock'); // DDL serialized across replicas
    expect(all).toContain('create or replace function ccc_page_cycle_guard()');
    // The per-workspace lock the trigger itself takes BEFORE walking (the race-safety of the guard).
    expect(all).toMatch(
      /pg_advisory_xact_lock\(485485, hashtext\(new\.workspace_id::text\)\)/,
    );
    expect(all).toContain('before update of parent_page_id on pages');
    expect(all).toContain('execute function ccc_page_cycle_guard()');
  });

  it('RETRIES while the engine tables are not ready, then succeeds', async () => {
    process.env.PAGE_CYCLE_GUARD_INSTALL_MAX_ATTEMPTS = '5';
    process.env.PAGE_CYCLE_GUARD_INSTALL_RETRY_MS = '0';
    let failedOnce = false;
    const spy = spyKysely((q) => {
      if (
        !failedOnce &&
        q.sql.includes('create trigger ccc_page_cycle_guard')
      ) {
        failedOnce = true;
        throw new Error('relation "pages" does not exist');
      }
      return [];
    });
    await expect(
      new PageCycleGuardInstaller(
        spy.db,
        'remote' as any,
      ).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'commit']);
  });

  it('REFUSES TO BOOT (fail-closed) in remote when the install never succeeds', async () => {
    process.env.PAGE_CYCLE_GUARD_INSTALL_MAX_ATTEMPTS = '2';
    process.env.PAGE_CYCLE_GUARD_INSTALL_RETRY_MS = '0';
    const spy = spyKysely(() => {
      throw new Error('permission denied for table pages');
    });
    await expect(
      new PageCycleGuardInstaller(
        spy.db,
        'remote' as any,
      ).onApplicationBootstrap(),
    ).rejects.toThrow(/page cycle guard install failed in remote mode/);
    expect(spy.tx).toEqual(['begin', 'rollback', 'begin', 'rollback']); // both attempts, both rolled back
  });
});
