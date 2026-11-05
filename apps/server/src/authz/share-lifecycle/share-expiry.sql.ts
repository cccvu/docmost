import { RawBuilder, sql } from 'kysely';

/**
 * CCC share lifecycle — NOT upstream Docmost code (#335, ADR 0032).
 *
 * The ONE definition of "is this public share still live", in SQL, decided against the database's `now()`. Every
 * remote-mode reader uses it: `PdpShareRepo` (findById / findByPageId / getShares / insertShare's cleanup), the
 * expiry sweeper, the expiry API and public discovery. There is no second copy of the rule anywhere.
 *
 * Effective expiry of a share `s`:
 *   - a `ccc_share_expiry` row exists → its `expires_at`; `null` there means "Never" (rendered as `'infinity'`)
 *   - no row                         → `s.created_at + 90 days` (the default for every share created after install)
 * A share is live iff its effective expiry is strictly after `now()`: at the exact instant it is already dead.
 *
 * The table exists only in remote mode (`ShareExpiryInstaller`); native mode never evaluates this. A read that
 * cannot evaluate it (the table missing, a timeout) throws — the caller gets an error and no content, never the share.
 */
export const SHARE_EXPIRY_TABLE = 'ccc_share_expiry';
export const DEFAULT_SHARE_TTL_DAYS = 90;
/** The durations the expiry API accepts (days); `null` there is the explicit "Never" opt-in. */
export const SHARE_EXPIRY_PRESET_DAYS = [7, 30, 90, 365] as const;
export type ShareExpiryPresetDays = (typeof SHARE_EXPIRY_PRESET_DAYS)[number];

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/** The SQL alias of the `shares` row the expression is correlated with (a bare identifier, never user input). */
function alias(shareAlias: string): string {
  if (!ALIAS.test(shareAlias)) throw new Error(`share expiry predicate: invalid alias ${JSON.stringify(shareAlias)}`);
  return shareAlias;
}

/**
 * The effective expiry of the share row aliased `shareAlias`, as a `timestamptz` that is never null: "Never" is
 * `'infinity'`. Raw SQL on purpose: written in snake_case, so Kysely's CamelCasePlugin leaves it alone.
 */
export function shareEffectiveExpirySql(shareAlias: string): RawBuilder<Date> {
  const a = alias(shareAlias);
  return sql<Date>`coalesce(
    (select coalesce(cse.expires_at, 'infinity'::timestamptz) from ccc_share_expiry cse where cse.share_id = ${sql.raw(`${a}.id`)}),
    ${sql.raw(`${a}.created_at`)} + make_interval(days => ${sql.lit(DEFAULT_SHARE_TTL_DAYS)})
  )`;
}

/** TRUE iff the share row aliased `shareAlias` is live now. Use as a WHERE / select expression. */
export function shareIsLiveSql(shareAlias: string): RawBuilder<boolean> {
  return sql<boolean>`(${shareEffectiveExpirySql(shareAlias)} > now())`;
}

/** The effective expiry as the API reports it: `null` for "Never", else the instant. */
export function shareReportedExpirySql(shareAlias: string): RawBuilder<Date | null> {
  return sql<Date | null>`nullif(${shareEffectiveExpirySql(shareAlias)}, 'infinity'::timestamptz)`;
}
