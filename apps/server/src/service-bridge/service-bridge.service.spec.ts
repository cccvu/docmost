import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ServiceBridgeService } from './service-bridge.service';
import { shadowEmailFor } from './shadow-user';

const EXTERNAL_ID = 'id-123';

const shadow = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: shadowEmailFor(EXTERNAL_ID),
  role: 'member',
  deletedAt: null,
  ...over,
});

/**
 * A minimal Kysely stand-in that answers ONLY the two queries the service issues:
 *  - `selectFrom('workspaces')…executeTakeFirst()` → the default-workspace resolution.
 *  - `insertInto('users')…executeTakeFirstOrThrow()` → provisioning; captures the inserted values.
 */
function makeDb(opts: { workspace?: { id: string } | undefined; insertedId?: string } = {}) {
  const workspace = 'workspace' in opts ? opts.workspace : { id: 'ws1' };
  const insertedId = opts.insertedId ?? 'new-id';
  const captured: { values?: Record<string, unknown> } = {};

  const wsChain: any = {
    select: () => wsChain,
    where: () => wsChain,
    orderBy: () => wsChain,
    limit: () => wsChain,
    executeTakeFirst: async () => workspace,
  };

  const onConflict = jest.fn((cb: any) => {
    cb({ columns: () => ({ doUpdateSet: () => ({}) }) });
    return { returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: insertedId }) }) };
  });
  const values = jest.fn((v: Record<string, unknown>) => {
    captured.values = v;
    return { onConflict };
  });

  const db: any = {
    selectFrom: (table: string) => {
      if (table !== 'workspaces') throw new Error(`unexpected selectFrom(${table})`);
      return wsChain;
    },
    insertInto: jest.fn((table: string) => {
      if (table !== 'users') throw new Error(`unexpected insertInto(${table})`);
      return { values };
    }),
  };
  return { db, captured, insertInto: db.insertInto };
}

function makeService(user: unknown, dbOpts?: Parameters<typeof makeDb>[0]) {
  const { db, captured, insertInto } = makeDb(dbOpts);
  const userRepo = { findByEmail: jest.fn(async () => user) } as any;
  const sessionService = {
    createSessionAndToken: jest.fn(async () => 'authtoken-xyz'),
  } as any;
  const svc = new ServiceBridgeService(db, userRepo, sessionService);
  return { svc, sessionService, userRepo, captured, insertInto };
}

describe('ServiceBridgeService.mintSession — no direct identity selection', () => {
  it('mints a session for a fork-owned shadow member, keyed only by externalId', async () => {
    const { svc, sessionService, userRepo } = makeService(shadow());
    await expect(svc.mintSession(EXTERNAL_ID)).resolves.toBe('authtoken-xyz');
    // The caller supplies only externalId; the FORK derives the shadow email + resolves the workspace.
    expect(userRepo.findByEmail).toHaveBeenCalledWith(shadowEmailFor(EXTERNAL_ID), 'ws1');
    expect(sessionService.createSessionAndToken).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing user (403, no token minted)', async () => {
    const { svc, sessionService } = makeService(undefined);
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('refuses a PRIVILEGED (non-member) user — never mints an admin/owner session', async () => {
    const { svc, sessionService } = makeService(shadow({ role: 'admin' }));
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('refuses a deleted user', async () => {
    const { svc } = makeService(shadow({ deletedAt: new Date() }));
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('defense-in-depth: refuses a resolved row whose email left the shadow namespace (tampered)', async () => {
    const { svc } = makeService(shadow({ email: 'real.person@vanderbilt.edu' }));
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('503s when the fork has no workspace provisioned yet (never a silent wrong workspace)', async () => {
    const { svc } = makeService(shadow(), { workspace: undefined });
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ServiceBridgeService.provisionShadowUser', () => {
  it('upserts a plain MEMBER with the fork-derived synthetic email + fork-resolved workspace', async () => {
    const { svc, captured, insertInto } = makeService(shadow());

    const result = await svc.provisionShadowUser({ externalId: EXTERNAL_ID } as any);

    expect(result).toEqual({ userId: 'new-id', workspaceId: 'ws1' });
    expect(insertInto).toHaveBeenCalledWith('users');
    const vals = captured.values as Record<string, unknown>;
    expect(vals.email).toBe(shadowEmailFor(EXTERNAL_ID));
    expect(vals.role).toBe('member'); // never elevated
    expect(vals.workspaceId).toBe('ws1'); // fork-resolved, not caller-supplied
    expect(typeof vals.password).toBe('string'); // an (unusable) hash, not null
  });
});
