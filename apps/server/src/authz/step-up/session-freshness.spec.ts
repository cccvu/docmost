import { BadRequestException } from '@nestjs/common';
import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import {
  AUTH_TIME_SKEW_SECONDS,
  MAX_FRESH_WINDOW_SECONDS,
  isFreshAt,
  mintFreshness,
  parseSessionFreshness,
  stampSessionFreshness,
} from './session-freshness';

/**
 * Step-up session freshness (wiki-v2 #713) — NOT upstream Docmost code. The mint's window rules (a violation is a
 * 400), the fail-closed read of a stored row, and the write's row scoping.
 */
const NOW = 1_800_000_000;

describe('mintFreshness — the mint body’s optional authTime/freshUntil', () => {
  it('absent ⇒ undefined (the session is simply not fresh)', () => {
    expect(mintFreshness(undefined, undefined, NOW)).toBeUndefined();
  });

  it('a valid pair is returned as is', () => {
    expect(mintFreshness(NOW - 10, NOW + 7190, NOW)).toEqual({ authTime: NOW - 10, freshUntil: NOW + 7190 });
  });

  it('accepts authTime up to the skew allowance in the future, and the full 24h window', () => {
    expect(mintFreshness(NOW + AUTH_TIME_SKEW_SECONDS, NOW + AUTH_TIME_SKEW_SECONDS + 1, NOW)).toBeDefined();
    expect(mintFreshness(NOW, NOW + MAX_FRESH_WINDOW_SECONDS, NOW)).toBeDefined();
  });

  it.each<[string, unknown, unknown]>([
    ['authTime alone', NOW, undefined],
    ['freshUntil alone', undefined, NOW + 60],
    ['authTime in the future beyond the skew', NOW + AUTH_TIME_SKEW_SECONDS + 1, NOW + 3600],
    ['freshUntil equal to authTime', NOW, NOW],
    ['freshUntil before authTime', NOW, NOW - 1],
    ['a window longer than 24h', NOW, NOW + MAX_FRESH_WINDOW_SECONDS + 1],
    ['a non-integer authTime', NOW + 0.5, NOW + 60],
    ['a string authTime', String(NOW), NOW + 60],
    ['a negative authTime', -5, 10],
    ['null for both', null, null],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
  ])('400s on %s', (_label, authTime, freshUntil) => {
    expect(() => mintFreshness(authTime as number, freshUntil as number, NOW)).toThrow(BadRequestException);
  });
});

describe('parseSessionFreshness — a stored user_sessions.metadata value, never throws', () => {
  it('reads an object (the production driver) and a JSON string (jest’s driver)', () => {
    const f = { authTime: NOW, freshUntil: NOW + 60 };
    expect(parseSessionFreshness(f)).toEqual(f);
    expect(parseSessionFreshness(JSON.stringify({ ...f, other: 'kept elsewhere' }))).toEqual(f);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['garbled JSON', '{"authTime":'],
    ['an array', [NOW, NOW + 60]],
    ['a number', NOW],
    ['a missing freshUntil', { authTime: NOW }],
    ['a string freshUntil', { authTime: NOW, freshUntil: String(NOW + 60) }],
    ['a fractional freshUntil', { authTime: NOW, freshUntil: NOW + 60.5 }],
    ['snake_case keys', { auth_time: NOW, fresh_until: NOW + 60 }],
  ])('%s ⇒ undefined', (_label, metadata) => {
    expect(parseSessionFreshness(metadata)).toBeUndefined();
  });
});

describe('isFreshAt — fail closed', () => {
  it('fresh strictly before freshUntil, stale from it on', () => {
    const f = { authTime: NOW - 100, freshUntil: NOW + 1 };
    expect(isFreshAt(f, NOW)).toBe(true);
    expect(isFreshAt(f, NOW + 1)).toBe(false);
    expect(isFreshAt(f, NOW + 2)).toBe(false);
  });

  it('no record is stale', () => {
    expect(isFreshAt(undefined, NOW)).toBe(false);
  });

  it('a stored row that breaks the mint’s rules is stale (tampered window, future authTime)', () => {
    expect(isFreshAt({ authTime: NOW - 10, freshUntil: NOW - 10 + MAX_FRESH_WINDOW_SECONDS + 1 }, NOW)).toBe(false);
    expect(isFreshAt({ authTime: NOW + AUTH_TIME_SKEW_SECONDS + 1, freshUntil: NOW + 3600 }, NOW)).toBe(false);
  });
});

describe('stampSessionFreshness — writes exactly the named row of the named user', () => {
  /** A Kysely with the fork's CamelCasePlugin over a driver that records each compiled query and answers `affected`. */
  function capturingDb(affected: bigint) {
    const queries: CompiledQuery[] = [];
    const connection = {
      executeQuery: async (q: CompiledQuery) => {
        queries.push(q);
        return { rows: [], numAffectedRows: affected };
      },
      streamQuery: () => {
        throw new Error('not used');
      },
    };
    const driver = new DummyDriver();
    driver.acquireConnection = async () => connection as any;
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
    });
    return { db, queries };
  }

  it('one UPDATE, scoped by session id AND user id, live rows only, merged into the jsonb', async () => {
    const { db, queries } = capturingDb(BigInt(1));
    await expect(
      stampSessionFreshness(db as any, 'session-1', 'user-1', { authTime: NOW, freshUntil: NOW + 60 }),
    ).resolves.toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toBe(
      `update "user_sessions" set "metadata" = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('authTime', $1::bigint, 'freshUntil', $2::bigint) where "id" = $3 and "user_id" = $4 and "revoked_at" is null`,
    );
    expect(queries[0].parameters).toEqual([NOW, NOW + 60, 'session-1', 'user-1']);
  });

  it('reports a write that touched no row', async () => {
    const { db } = capturingDb(BigInt(0));
    await expect(
      stampSessionFreshness(db as any, 'session-1', 'user-1', { authTime: NOW, freshUntil: NOW + 60 }),
    ).resolves.toBe(false);
  });
});
