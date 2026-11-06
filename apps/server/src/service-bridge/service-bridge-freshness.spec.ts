import { InternalServerErrorException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { ServiceBridgeService } from './service-bridge.service';
import { shadowEmailFor } from './shadow-user';

/**
 * `POST /api/service/session` step-up freshness (wiki-v2 #713) — CCC service-bridge, NOT upstream Docmost code.
 *
 * The mint stores the platform's `{authTime, freshUntil}` on the row `createSessionAndToken` just inserted — the row
 * the returned token names — and on nothing else. A mint without freshness writes nothing extra (the session is not
 * fresh). A stamp that touches no row revokes the session and fails the mint rather than hand back a session the
 * platform believes fresh. The row-level effect against a real Postgres is `step-up/session-freshness.pg.spec.ts`.
 */
const EXTERNAL_ID = 'id-123';
const USER = { id: 'u1', workspaceId: 'ws1', email: shadowEmailFor(EXTERNAL_ID), role: 'member', deletedAt: null };
const NOW = Math.floor(Date.now() / 1000);

function capturingDb(affected: bigint) {
  const queries: CompiledQuery[] = [];
  const driver = new DummyDriver();
  driver.acquireConnection = async () =>
    ({
      executeQuery: async (q: CompiledQuery) => {
        queries.push(q);
        return { rows: [], numAffectedRows: affected };
      },
      streamQuery: () => {
        throw new Error('not used');
      },
    }) as any;
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

function makeService(opts: { affected?: bigint; token?: string } = {}) {
  const { db, queries } = capturingDb(opts.affected ?? BigInt(1));
  const token = opts.token ?? sign({ sub: USER.id, sessionId: 'session-new', type: 'access' }, 'test-secret');
  const sessionService = { createSessionAndToken: jest.fn(async () => token) } as any;
  const userSessionRepo = { revokeById: jest.fn(async () => undefined) } as any;
  const svc = new ServiceBridgeService(
    db as any,
    { findByEmail: jest.fn(async () => USER) } as any,
    userSessionRepo,
    sessionService,
    { resolveDefaultWorkspaceId: jest.fn(async () => 'ws1') } as any,
    { get: () => undefined, set: () => undefined } as any,
  );
  return { svc, queries, sessionService, userSessionRepo, token };
}

describe('ServiceBridgeService.mintSession — step-up freshness (#713)', () => {
  it('stamps exactly the minted row (the token’s own sessionId) of the minted user', async () => {
    const { svc, queries, token } = makeService();
    await expect(svc.mintSession(EXTERNAL_ID, undefined, { authTime: NOW, freshUntil: NOW + 7200 })).resolves.toBe(
      token,
    );
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/^update "user_sessions" set "metadata" = .* where "id" = \$3 and "user_id" = \$4/);
    expect(queries[0].parameters).toEqual([NOW, NOW + 7200, 'session-new', USER.id]);
  });

  it('without freshness, writes nothing beyond the native mint (the session is simply not fresh)', async () => {
    const { svc, queries, sessionService } = makeService();
    await svc.mintSession(EXTERNAL_ID);
    expect(sessionService.createSessionAndToken).toHaveBeenCalledTimes(1);
    expect(queries).toEqual([]);
  });

  it('a stamp that touches no row revokes that session and fails the mint (500, never a silently stale token)', async () => {
    const { svc, userSessionRepo } = makeService({ affected: BigInt(0) });
    await expect(
      svc.mintSession(EXTERNAL_ID, undefined, { authTime: NOW, freshUntil: NOW + 7200 }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(userSessionRepo.revokeById).toHaveBeenCalledWith('session-new', USER.id, USER.workspaceId);
  });

  it('a token that names no session fails the mint without writing', async () => {
    const { svc, queries } = makeService({ token: sign({ sub: USER.id }, 'test-secret') });
    await expect(
      svc.mintSession(EXTERNAL_ID, undefined, { authTime: NOW, freshUntil: NOW + 7200 }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(queries).toEqual([]);
  });
});
