import {
  CamelCasePlugin,
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';

/**
 * Test-only harness for the PdpSearchService unit specs (#696) — NOT built into dist (`.testkit.ts` is excluded in
 * tsconfig.build.json) and NOT a jest suite.
 *
 * A real Kysely (Postgres compiler + the production CamelCasePlugin) over a driver that RECORDS every compiled
 * query and answers the three statement kinds search runs:
 *   - `SET LOCAL statement_timeout = <ms>` → recorded, no rows;
 *   - the CANDIDATE statement (`from "pages"`, a `limit`, no `"id" in (`) → the first `limit` fixture rows, each
 *     narrowed to `{ id, rank }` (the statement selects nothing else);
 *   - the HYDRATE statement (`"id" in (…)`) → the full fixture rows for those ids, minus `trashed`, in REVERSE order
 *     (SQL `in` has no order; the service must restore the candidate order itself).
 * Anything else answers no rows. `delayMs` / `fail` model a slow or failing statement; `answer` (#716) gives the rows of
 * any other statement (the share search's restricted-ancestor and subtree reads), ahead of the built-in kinds.
 */
export type SearchRow = { id: string; rank?: number; title?: string; highlight?: string | null; [k: string]: unknown };

export interface SearchDbOpts {
  candidates: SearchRow[];
  /** Ids the hydrate statement no longer finds live (trashed between the gate and the hydrate). */
  trashed?: Set<string>;
  delayMs?: (q: CompiledQuery) => number;
  fail?: (q: CompiledQuery) => Error | undefined;
  /** Rows for a statement the built-in kinds do not model; `undefined` falls through to them. */
  answer?: (q: CompiledQuery) => unknown[] | undefined;
}

export const isSetTimeout = (q: CompiledQuery) => /^set local statement_timeout/i.test(q.sql);
export const isHydrate = (q: CompiledQuery) => /from "pages"/.test(q.sql) && /"id" in \(/.test(q.sql);
export const isCandidate = (q: CompiledQuery) =>
  /from "pages"/.test(q.sql) && / limit \$\d+$/.test(q.sql) && !isHydrate(q);

export function searchDb(opts: SearchDbOpts) {
  const queries: CompiledQuery[] = [];
  const tx: Array<'begin' | 'commit' | 'rollback'> = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(cq);
      const delay = opts.delayMs?.(cq) ?? 0;
      if (delay > 0) await new Promise((r) => (setTimeout(r, delay) as unknown as { unref: () => void }).unref());
      const err = opts.fail?.(cq);
      if (err) throw err;
      if (isSetTimeout(cq)) return { rows: [] };
      const answered = opts.answer?.(cq);
      if (answered) return { rows: answered as R[] };
      if (isHydrate(cq)) {
        const m = /"id" in \(([^)]*)\)/.exec(cq.sql)!;
        const ids = m[1].split(',').map((p) => String(cq.parameters[Number(p.trim().slice(1)) - 1]));
        const rows = opts.candidates
          .filter((r) => ids.includes(r.id) && !opts.trashed?.has(r.id))
          .reverse();
        return { rows: rows as unknown as R[] };
      }
      if (isCandidate(cq)) {
        const m = / limit \$(\d+)$/.exec(cq.sql)!;
        const limit = Number(cq.parameters[Number(m[1]) - 1]);
        const rows = opts.candidates.slice(0, limit).map((r) => ({ id: r.id, rank: r.rank }));
        return { rows: rows as unknown as R[] };
      }
      return { rows: [] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
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
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
  return {
    db,
    queries,
    tx,
    candidateQueries: () => queries.filter(isCandidate),
    hydrateQueries: () => queries.filter(isHydrate),
    timeouts: () => queries.filter(isSetTimeout),
  };
}

/** A PDP stub: `tryFilterResources` admits every id not in the denied set of that leg (user / service). */
export function pdpStub(o: { userDenied?: Set<string>; serviceDenied?: Set<string> } = {}) {
  return {
    tryFilterResources: jest.fn(
      async (subject: any, _p: string, _t: string, ids: string[]): Promise<string[] | null> => {
        const denied = subject?.subjectType === 'service' ? o.serviceDenied : o.userDenied;
        return ids.filter((id) => !(denied ?? new Set()).has(id));
      },
    ),
  };
}

/** The user-leg calls of a `pdpStub` (the service leg names `subjectType: 'service'`). */
export const userLegCalls = (pdp: ReturnType<typeof pdpStub>) =>
  pdp.tryFilterResources.mock.calls.filter((c) => c[0]?.subjectType !== 'service');
export const serviceLegCalls = (pdp: ReturnType<typeof pdpStub>) =>
  pdp.tryFilterResources.mock.calls.filter((c) => c[0]?.subjectType === 'service');
