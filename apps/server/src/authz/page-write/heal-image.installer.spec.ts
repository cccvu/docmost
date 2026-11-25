import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { bootSealDb, installHealImageTableAtBoot } from './heal-image.installer';

/**
 * #851: the boot install of the heal image tables (heal-image.installer.ts) is fail-closed with a bounded retry. A fake
 * database whose install transaction fails `failures` times, then succeeds: the retry must really re-run the install
 * (`ensureHealImageTable` forgets a failed promise), a boot past the last attempt must throw with
 * `HEAL_IMAGE_INSTALL_FAILED`, and `bootSealDb()` names the handle only after a success. The DDL itself runs on real
 * Postgres in heal-image.pg.spec.ts. Module state (`bootDb`): the cases run in order, the failing one first.
 */
function fakeDb(failures: number) {
  let attempts = 0;
  const db = {
    transaction: () => ({
      execute: () => (++attempts <= failures ? Promise.reject(new Error('down')) : Promise.resolve()),
    }),
  };
  return { db: db as unknown as KyselyDB, attempts: () => attempts };
}
const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('installHealImageTableAtBoot (#851)', () => {
  it('always failing: retries up to maxAttempts, logs HEAL_IMAGE_INSTALL_FAILED once, throws, and sets no boot handle', async () => {
    const { db, attempts } = fakeDb(Infinity);
    const log = logger();
    await expect(installHealImageTableAtBoot(db, log, 3, 0)).rejects.toThrow(/^heal image table install failed: down$/);
    expect(attempts()).toBe(3); // each attempt ran the install again
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenNthCalledWith(1, 'heal image table install attempt 1 failed: down');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(/^HEAL_IMAGE_INSTALL_FAILED after 3 attempts — refusing to boot: down$/);
    expect(log.log).not.toHaveBeenCalled();
    expect(bootSealDb()).toBeNull();
  });

  it('failing twice, then succeeding: resolves on the third attempt and names the boot handle', async () => {
    const { db, attempts } = fakeDb(2);
    const log = logger();
    await expect(installHealImageTableAtBoot(db, log, 3, 0)).resolves.toBeUndefined();
    expect(attempts()).toBe(3); // a failed install is forgotten, so the retry re-runs it
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledWith('ccc_page_heal_image ensured on Docmost DB');
    expect(bootSealDb()).toBe(db);
  });

  it('a single attempt (the minimum) fails the boot without a retry', async () => {
    const { db, attempts } = fakeDb(1);
    const log = logger();
    await expect(installHealImageTableAtBoot(db, log, 1, 0)).rejects.toThrow(/install failed/);
    expect(attempts()).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
