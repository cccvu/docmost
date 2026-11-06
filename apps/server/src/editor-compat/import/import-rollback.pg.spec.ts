import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import {
  PG_URL,
  bootstrapSchema,
  mkReadModelDb,
  mkReadModelPg,
} from '../../service-bridge/read-model-pg.testkit';

/**
 * CCC #716 I2 (review): the zip import tells a certain rollback from an unknown outcome by whether its transaction
 * callback finished (`txBodyFinished`, seam #176). This pins the Kysely behaviour that rule rests on, on real Postgres:
 *   - a callback that throws is rolled back WITHOUT a COMMIT, and the error reaches the caller with the flag unset;
 *   - a failure raised BY the COMMIT (a deferred constraint trigger stands in for a reset or timeout on COMMIT)
 *     reaches the caller AFTER the callback returned, with the flag set — the case that must delete nothing.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG import rollback classification gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'import_rollback_pg_spec';

d('import transaction outcome on real Postgres (#716 I2)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await pg.unsafe(`
      create table pages (id text primary key, fail_at_commit boolean not null default false);
      create function refuse_at_commit() returns trigger language plpgsql as $$
        begin raise exception 'refused at commit'; end $$;
      create constraint trigger refuse_at_commit after insert on pages deferrable initially deferred
        for each row when (new.fail_at_commit) execute function refuse_at_commit();
    `);
  });
  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  /** The import's shape: the flag is the callback's last statement, as in seam #176. */
  const run = async (
    rows: Array<{ id: string; failAtCommit?: boolean }>,
    throwInBody: boolean,
  ) => {
    let txBodyFinished = false;
    const err = await db
      .transaction()
      .execute(async (trx) => {
        for (const r of rows) await trx.insertInto('pages').values(r).execute();
        if (throwInBody) throw new Error('conversion failed on the last page');
        txBodyFinished = true;
      })
      .then(
        () => null,
        (e: Error) => e,
      );
    return { err, txBodyFinished };
  };

  it('a callback that throws is rolled back before COMMIT: the flag is unset, so cleanup is certain to be safe', async () => {
    const { err, txBodyFinished } = await run(
      [{ id: 'body-1' }, { id: 'body-2' }],
      true,
    );
    expect(err?.message).toBe('conversion failed on the last page');
    expect(txBodyFinished).toBe(false);
    expect(await pg`select id from pages where id like 'body-%'`).toHaveLength(
      0,
    );
  });

  it('a failure raised by COMMIT arrives after the callback returned: the flag is set, so nothing is deleted', async () => {
    const { err, txBodyFinished } = await run(
      [{ id: 'commit-1' }, { id: 'commit-2', failAtCommit: true }],
      false,
    );
    expect(err?.message).toMatch(/refused at commit/);
    expect(txBodyFinished).toBe(true);
  });

  it('control: a transaction that commits sets the flag and keeps its rows', async () => {
    const { err, txBodyFinished } = await run([{ id: 'ok-1' }], false);
    expect(err).toBeNull();
    expect(txBodyFinished).toBe(true);
    expect(await pg`select id from pages where id = 'ok-1'`).toHaveLength(1);
  });
});
