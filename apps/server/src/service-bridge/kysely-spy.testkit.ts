import {
  CamelCasePlugin,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

/**
 * A test-only Kysely backed by a fake driver. It REALLY compiles queries with the Postgres compiler + the
 * CamelCasePlugin (same as production), records every compiled query, and returns rows from a caller-
 * supplied `respond` function (which may throw to simulate a DB error). Transaction begin/commit/rollback
 * are recorded too, so a rollback-on-error path is observable. This lets the raw-`sql` service-bridge
 * services be unit-tested without a real Postgres.
 *
 * NOT built into dist (the ".testkit.ts" suffix is excluded in tsconfig.build.json) and NOT a jest suite
 * (testRegex matches only ".spec.ts" files).
 */
export interface SpyQuery {
  sql: string;
  parameters: readonly unknown[];
}

export interface KyselySpy {
  db: KyselyDB;
  calls: SpyQuery[];
  tx: Array<'begin' | 'commit' | 'rollback'>;
}

export function spyKysely(respond: (q: SpyQuery) => unknown[]): KyselySpy {
  const calls: SpyQuery[] = [];
  const tx: Array<'begin' | 'commit' | 'rollback'> = [];

  const connection = {
    async executeQuery(compiled: { sql: string; parameters: readonly unknown[] }) {
      const q: SpyQuery = { sql: compiled.sql, parameters: compiled.parameters };
      calls.push(q);
      return { rows: respond(q) }; // respond may throw to simulate a DB failure
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streamQuery not supported in the spy');
    },
  };

  const driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {
      tx.push('begin');
    },
    async commitTransaction() {
      tx.push('commit');
    },
    async rollbackTransaction() {
      tx.push('rollback');
    },
    async releaseConnection() {},
    async destroy() {},
  };

  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver as any,
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (d: Kysely<any>) => new PostgresIntrospector(d),
    },
    plugins: [new CamelCasePlugin()],
  });

  return { db: db as unknown as KyselyDB, calls, tx };
}
