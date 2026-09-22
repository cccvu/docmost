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

function makeService(
  user: unknown,
  opts: { workspaceId?: string | null; activeSessions?: number } = {},
) {
  const { db, captured, insertInto } = makeDb();
  // executeTx(db, cb) → db.transaction().execute(cb); the repo mocks ignore the trx arg, so a passthrough
  // trx is enough to exercise deactivateShadowUser's transactional deactivate + revoke (#455).
  db.transaction = jest.fn(() => ({
    execute: (fn: (trx: unknown) => unknown) => fn({}),
  }));
  const userRepo = {
    findByEmail: jest.fn(async () => user),
    updateUser: jest.fn(async () => undefined),
  } as any;
  const activeSessions = Array.from({ length: opts.activeSessions ?? 0 }, () => ({}));
  const userSessionRepo = {
    findActiveByUser: jest.fn(async () => activeSessions),
    revokeByUserId: jest.fn(async () => undefined),
  } as any;
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
  const svc = new ServiceBridgeService(
    db,
    userRepo,
    userSessionRepo,
    sessionService,
    workspaces,
  );
  return {
    svc,
    sessionService,
    userRepo,
    userSessionRepo,
    captured,
    insertInto,
    workspaces,
  };
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

  // F1 (companion #272): a DEACTIVATED shadow member (deactivatedAt set, deletedAt still null — the state a
  // workspace admin's "deactivate member" produces) must also be refused. `isUserDisabled` = deactivatedAt
  // OR deletedAt is the platform-wide "not usable" predicate every native auth entrypoint enforces; the
  // mint path checking only `deletedAt` was a fail-OPEN divergence that would issue a live session to a
  // deliberately-disabled account.
  it('F1: refuses a DEACTIVATED user (deactivatedAt set, not deleted) — no fail-open divergence', async () => {
    const { svc, sessionService } = makeService(
      shadow({ deactivatedAt: new Date(), deletedAt: null }),
    );
    await expect(svc.mintSession(EXTERNAL_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('defense-in-depth: refuses a resolved row whose email left the shadow namespace (tampered)', async () => {
    const { svc } = makeService(shadow({ email: 'real.person@example.edu' }));
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
      shadow({ deactivatedAt: new Date(), deletedAt: null }), // deactivated (F1)
      shadow({ role: 'owner' }), // privileged
      shadow({ email: 'real@example.edu' }), // outside namespace
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

  // T-030 (issue #50 + companion P5/F3): the takeover boundary IS the conflict target. Only a row the fork
  // owns can match (reserved synthetic domain + same workspace). The conflict update SELF-HEALS to the
  // "plain, live member" shape provisioning promises — resurrect (deletedAt:null), de-escalate
  // (role:'member'), refresh emailVerifiedAt — but must NEVER rewrite the password or the email.
  // `role` is PRESENT in the update but pinned to the literal 'member', which STRENGTHENS no-escalation
  // (the upsert can only ever write plain-member) and matches the sibling `space_members` upsert.
  //
  // CCC (real names): `name` is now updated ONLY when the caller supplied one. A NAMELESS re-provision —
  // the space control-plane path (service-space.service.ts), which knows only the externalId — must NOT
  // clobber an existing good name back to the UUID, so `name` is ABSENT from the conflict update here.
  it('T-030: nameless re-provision self-heals to plain-member and does NOT rewrite name (no clobber); never password/email/role-escalation', async () => {
    const { svc, captured } = makeService(shadow());

    await svc.provisionShadowUser({ externalId: EXTERNAL_ID } as any);

    expect(captured.conflictColumns).toEqual(['email', 'workspaceId']);
    const update = captured.conflictUpdate as Record<string, unknown>;
    expect(update).not.toHaveProperty('name'); // the load-bearing no-clobber assertion
    expect(new Set(Object.keys(update))).toEqual(
      new Set(['emailVerifiedAt', 'deletedAt', 'role']),
    );
    expect(update.role).toBe('member'); // only ever the plain-member literal — no escalation vector
    expect(update.deletedAt).toBeNull();
    expect(update).not.toHaveProperty('password'); // a credential swap must never ride a re-provision
    expect(update).not.toHaveProperty('email');
  });

  // CCC (real names): a NAMED re-provision (login path with the platform display name, or an admin
  // rename write-through) DOES refresh `name` — trimmed — so the wiki reflects the current name.
  it('a named re-provision writes the trimmed name in the conflict update (rename propagation)', async () => {
    const { svc, captured } = makeService(shadow());

    await svc.provisionShadowUser({ externalId: EXTERNAL_ID, name: '  Alice Ng  ' } as any);

    const update = captured.conflictUpdate as Record<string, unknown>;
    expect(update.name).toBe('Alice Ng');
    expect(new Set(Object.keys(update))).toEqual(
      new Set(['name', 'emailVerifiedAt', 'deletedAt', 'role']),
    );
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
   * T-036 (companion issue P5 — FIXED). A soft-deleted shadow user (offboarding, DB restore to a deleted
   * state) must become usable again on re-provision, or `mintSession` disqualifies on `deletedAt` forever.
   * The conflict update now clears `deletedAt`, so re-provisioning the same externalId resurrects the
   * fork-owned row. (Was committed red-on-purpose; the P5 fix flips it green.) Real-Postgres mirror: T-046.
   */
  it('T-036: re-provisioning a soft-deleted shadow user clears deletedAt (resurrects the row)', async () => {
    const { svc, captured } = makeService(shadow());

    await svc.provisionShadowUser({ externalId: EXTERNAL_ID } as any);

    expect(captured.conflictUpdate).toMatchObject({ deletedAt: null });
  });
});

// #455 — fork-side instant revocation. Deactivating the shadow user is the single lever that closes EVERY
// fork content entrypoint (isUserDisabled is checked by jwt.strategy, onAuthenticate, and mintSession), so
// disable() can stop a disabled identity reading/writing wiki content through an already-issued fork
// credential. Real-Postgres mirror + the end-to-end mint/jwt refusal live in service-bridge.pg.spec.ts.
describe('ServiceBridgeService.deactivateShadowUser (#455)', () => {
  it('sets deactivatedAt AND revokes the shadow user’s live sessions, in one transaction', async () => {
    const { svc, userRepo, userSessionRepo } = makeService(shadow(), {
      activeSessions: 3,
    });

    const res = await svc.deactivateShadowUser(EXTERNAL_ID);

    expect(res).toEqual({ userId: 'u1', deactivated: true, sessionsRevoked: 3 });
    expect(userRepo.findByEmail).toHaveBeenCalledWith(
      shadowEmailFor(EXTERNAL_ID),
      'ws1',
    );
    // deactivatedAt set (NEVER deletedAt — disable is reversible), sessions revoked, both scoped to the id+ws.
    expect(userRepo.updateUser).toHaveBeenCalledTimes(1);
    const [patch, id, ws] = userRepo.updateUser.mock.calls[0];
    expect(patch.deactivatedAt).toBeInstanceOf(Date);
    expect(patch).not.toHaveProperty('deletedAt');
    expect([id, ws]).toEqual(['u1', 'ws1']);
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalledWith(
      'u1',
      'ws1',
      expect.anything(), // the transaction handle
    );
  });

  it('is a benign no-op success for a never-provisioned identity (no shadow user)', async () => {
    const { svc, userRepo, userSessionRepo } = makeService(undefined);

    const res = await svc.deactivateShadowUser(EXTERNAL_ID);

    expect(res).toEqual({ userId: null, deactivated: false, sessionsRevoked: 0 });
    expect(userRepo.updateUser).not.toHaveBeenCalled();
    expect(userSessionRepo.revokeByUserId).not.toHaveBeenCalled();
  });

  it('is idempotent — re-deactivating an already-deactivated shadow user still succeeds (retry-before-enable)', async () => {
    const { svc, userRepo } = makeService(
      shadow({ deactivatedAt: new Date(), deletedAt: null }),
      { activeSessions: 0 },
    );

    const res = await svc.deactivateShadowUser(EXTERNAL_ID);

    expect(res).toMatchObject({ userId: 'u1', deactivated: true });
    // No "already deactivated" throw (unlike native deactivateUser) — the sweep just re-runs harmlessly.
    expect(userRepo.updateUser).toHaveBeenCalledTimes(1);
  });

  it('503s when the fork has no workspace provisioned yet (never a silent wrong workspace)', async () => {
    const { svc } = makeService(shadow(), { workspaceId: null });
    await expect(svc.deactivateShadowUser(EXTERNAL_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ServiceBridgeService.reactivateShadowUser (#455)', () => {
  it('clears deactivatedAt (only) for a deactivated shadow user', async () => {
    const { svc, userRepo } = makeService(
      shadow({ deactivatedAt: new Date(), deletedAt: null }),
    );

    const res = await svc.reactivateShadowUser(EXTERNAL_ID);

    expect(res).toEqual({ userId: 'u1', reactivated: true });
    const [patch, id, ws] = userRepo.updateUser.mock.calls[0];
    expect(patch).toEqual({ deactivatedAt: null }); // touches ONLY deactivatedAt, never deletedAt
    expect([id, ws]).toEqual(['u1', 'ws1']);
  });

  it('is a no-op for an already-active shadow user (idempotent)', async () => {
    const { svc, userRepo } = makeService(shadow({ deactivatedAt: null }));

    const res = await svc.reactivateShadowUser(EXTERNAL_ID);

    expect(res).toEqual({ userId: 'u1', reactivated: false });
    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('is a no-op for a never-provisioned identity', async () => {
    const { svc, userRepo } = makeService(undefined);

    const res = await svc.reactivateShadowUser(EXTERNAL_ID);

    expect(res).toEqual({ userId: null, reactivated: false });
    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });
});
