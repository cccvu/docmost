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
 * A minimal Kysely stand-in that answers ONLY the one query the service issues directly:
 *  - `insertInto('users')…executeTakeFirstOrThrow()` → provisioning; captures the inserted values AND
 *    (issue #50) the `onConflict` target columns + `doUpdateSet` payload, so the conflict semantics are
 *    asserted rather than assumed.
 * The default-workspace resolution now lives in WorkspaceResolver (mocked separately below); the REAL
 * upsert SQL is proven against Postgres in `service-bridge.pg.spec.ts` (T-040…T-046).
 */
function makeDb(opts: { insertedId?: string } = {}) {
  const insertedId = opts.insertedId ?? 'new-id';
  const captured: {
    values?: Record<string, unknown>;
    conflictColumns?: string[];
    conflictUpdate?: Record<string, unknown>;
  } = {};

  const onConflict = jest.fn((cb: any) => {
    cb({
      columns: (cols: string[]) => {
        captured.conflictColumns = cols;
        return {
          doUpdateSet: (v: Record<string, unknown>) => {
            captured.conflictUpdate = v;
            return {};
          },
        };
      },
    });
    return { returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: insertedId }) }) };
  });
  const values = jest.fn((v: Record<string, unknown>) => {
    captured.values = v;
    return { onConflict };
  });

  const db: any = {
    insertInto: jest.fn((table: string) => {
      if (table !== 'users') throw new Error(`unexpected insertInto(${table})`);
      return { values };
    }),
  };
  return { db, captured, insertInto: db.insertInto };
}

function makeService(user: unknown, opts: { workspaceId?: string | null } = {}) {
  const { db, captured, insertInto } = makeDb();
  const userRepo = { findByEmail: jest.fn(async () => user) } as any;
  const sessionService = {
    createSessionAndToken: jest.fn(async () => 'authtoken-xyz'),
  } as any;
  const workspaceId = 'workspaceId' in opts ? opts.workspaceId : 'ws1';
  const workspaces = {
    resolveDefaultWorkspaceId: jest.fn(async () => {
      if (workspaceId == null) {
        throw new ServiceUnavailableException('no workspace provisioned');
      }
      return workspaceId;
    }),
  } as any;
  const svc = new ServiceBridgeService(db, userRepo, sessionService, workspaces);
  return { svc, sessionService, userRepo, captured, insertInto, workspaces };
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
    const { svc } = makeService(shadow(), { workspaceId: null });
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // T-033 (issue #50): a refusal must not disclose WHICH condition failed (missing vs deleted vs
  // privileged vs outside-namespace are all one message and one status), or the 403 becomes an
  // enumeration oracle for the shadow namespace / role state.
  it('T-033: every refusal reason is a uniform 403 with an identical message', async () => {
    const reasons: Array<unknown> = [
      undefined, // no such user
      shadow({ deletedAt: new Date() }), // deleted
      shadow({ role: 'owner' }), // privileged
      shadow({ email: 'real@vanderbilt.edu' }), // outside namespace
    ];
    const observed: Array<{ status?: number; message?: string }> = [];
    for (const user of reasons) {
      const { svc } = makeService(user);
      const err = await svc.mintSession(EXTERNAL_ID).then(
        () => undefined,
        (e: any) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      observed.push({ status: err.getStatus?.(), message: err.message });
    }
    expect(new Set(observed.map((o) => JSON.stringify(o))).size).toBe(1); // one shape for all reasons
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

  // T-030 (issue #50): the takeover boundary IS the conflict target. Only a row the fork owns can match
  // (reserved synthetic domain + same workspace), and a conflict must NEVER rewrite the security-bearing
  // columns — so a tampered/pre-existing row can't be escalated or credential-swapped by re-provisioning.
  it('T-030: the upsert conflicts on (email, workspaceId) and updates ONLY emailVerifiedAt', async () => {
    const { svc, captured } = makeService(shadow());

    await svc.provisionShadowUser({ externalId: EXTERNAL_ID } as any);

    expect(captured.conflictColumns).toEqual(['email', 'workspaceId']);
    const update = captured.conflictUpdate as Record<string, unknown>;
    expect(Object.keys(update)).toEqual(['emailVerifiedAt']);
    expect(update).not.toHaveProperty('role');
    expect(update).not.toHaveProperty('password');
    expect(update).not.toHaveProperty('email');
  });

  // T-031 (issue #50): the no-workspace guard fires BEFORE any write — never create a shadow user in an
  // unknown/placeholder workspace.
  it('T-031: 503s on no provisioned workspace and performs NO insert', async () => {
    const { svc, insertInto } = makeService(shadow(), { workspaceId: null });
    await expect(svc.provisionShadowUser({ externalId: EXTERNAL_ID } as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(insertInto).not.toHaveBeenCalled();
  });

  // T-032: the display name is cosmetic; a blank one falls back to externalId (so the fork never stores an
  // empty/blank name) and a provided one is trimmed.
  it('T-032: blank name falls back to externalId; provided name is trimmed', async () => {
    const blank = makeService(shadow());
    await blank.svc.provisionShadowUser({ externalId: EXTERNAL_ID, name: '   ' } as any);
    expect((blank.captured.values as Record<string, unknown>).name).toBe(EXTERNAL_ID);

    const named = makeService(shadow());
    await named.svc.provisionShadowUser({ externalId: EXTERNAL_ID, name: '  Alice  ' } as any);
    expect((named.captured.values as Record<string, unknown>).name).toBe('Alice');
  });

  /**
   * T-036 (RED — companion issue P5). The conflict update touches only `emailVerifiedAt`, so a shadow user
   * that was soft-deleted (offboarding, DB restore to a deleted state) can NEVER become usable again:
   * `mintSession` disqualifies on `deletedAt` forever. Intended behavior: re-provisioning the same
   * externalId resurrects the fork-owned row (`deletedAt: null`). Left red on purpose.
   * Real-Postgres mirror: T-046.
   */
  it('T-036 🔴 re-provisioning a soft-deleted shadow user clears deletedAt (currently resurrects nothing)', async () => {
    const { svc, captured } = makeService(shadow());

    await svc.provisionShadowUser({ externalId: EXTERNAL_ID } as any);

    expect(captured.conflictUpdate).toMatchObject({ deletedAt: null });
  });
});
