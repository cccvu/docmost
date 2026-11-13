import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { WorkspaceResolver } from './workspace-resolver';
import { ServiceBridgeController } from './service-bridge.controller';
import { SHADOW_EMAIL_DOMAIN, shadowEmailFor } from './shadow-user';
import { spyKysely } from './kysely-spy.testkit';

describe('WorkspaceResolver.resolveDefaultWorkspaceId (canonical single-tenant workspace)', () => {
  it('selects the OLDEST non-deleted workspace (deterministic: order by created_at asc, id asc)', async () => {
    // The query itself pins determinism: order by created_at asc THEN id asc (F4 tiebreak) means the DB
    // returns exactly the oldest, and rows created in the same instant no longer resolve non-deterministically.
    const { resolver, spy } = makeResolver([{ id: 'ws-oldest' }]);
    await expect(resolver.resolveDefaultWorkspaceId()).resolves.toBe('ws-oldest');
    const sql = spy.calls[0].sql.toLowerCase();
    expect(sql).toContain('order by');
    expect(sql).toContain('created_at');
    expect(sql).toContain('asc');
    expect(sql).toContain('limit');
    expect(sql).toContain('deleted_at'); // excludes soft-deleted workspaces
    expect(sql).toMatch(/order by .*created_at.* asc, .*id.* asc/); // F4: deterministic secondary tiebreak
  });

  it('503s when NO workspace is provisioned (never a silent wrong workspace)', async () => {
    const { resolver } = makeResolver([]);
    await expect(resolver.resolveDefaultWorkspaceId()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // F4 (companion #272): more than one non-deleted workspace breaches the single-tenant invariant. The
  // resolver must still return a DETERMINISTIC answer (the oldest) — never flip between calls — and must
  // WARN so the anomaly is visible, but must NOT hard-fail (that would take the whole east-west surface down
  // over an accidental second workspace).
  it('F4: with >1 non-deleted workspace, returns the oldest deterministically and WARNs (no hard-fail)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { resolver } = makeResolver([{ id: 'ws-oldest' }, { id: 'ws-second' }]);
      await expect(resolver.resolveDefaultWorkspaceId()).resolves.toBe('ws-oldest');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/single-tenant invariant/i);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * #871: `resolveUser` answers the user's workspace AND, for a shadow user, the platform identity it stands for
 * (`externalId`), so a membership an admin wrote before that identity's first sign-in projects onto the identity
 * instead of an inert anchor. Only a well-formed reserved-namespace email names an identity: every other user
 * (a native account, a lookalike, a row with no email) answers null, so the platform can never be talked into
 * linking a real or privileged Docmost user to an identity.
 */
describe('WorkspaceResolver.resolveUser (#871)', () => {
  const SHADOW = `9B1F0C2E-0000-4000-8000-00000000AB12@${SHADOW_EMAIL_DOMAIN}`;

  it('returns the workspace and null externalId for a native user, binding the user id as a parameter', async () => {
    const spy = spyKysely(() => [{ workspace_id: 'ws1', email: 'real.person@example.edu' }]);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUser('user-42')).resolves.toEqual({ workspaceId: 'ws1', externalId: null });
    const sql = spy.calls[0].sql.toLowerCase();
    expect(sql).toContain('from users where id =');
    expect(sql).toMatch(/select workspace_id, email\b/); // the email is what names the identity
    expect(spy.calls[0].parameters).toEqual(['user-42']);
  });

  it('names the identity a shadow user stands for: the lower-cased local part of its reserved email', async () => {
    const spy = spyKysely(() => [{ workspace_id: 'ws1', email: SHADOW }]);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUser('user-42')).resolves.toEqual({
      workspaceId: 'ws1',
      externalId: '9b1f0c2e-0000-4000-8000-00000000ab12',
    });
  });

  it('the externalId it answers is the one provisioning derived the email from (shadowEmailFor round-trip)', async () => {
    const id = '9b1f0c2e-0000-4000-8000-0000000000c3';
    const spy = spyKysely(() => [{ workspace_id: 'ws1', email: shadowEmailFor(id) }]);
    await expect(new WorkspaceResolver(spy.db).resolveUser('user-42')).resolves.toEqual({ workspaceId: 'ws1', externalId: id });
  });

  // The recognizer is the boundary: a row that merely CONTAINS the reserved domain (F7's embedded-@ breakout, a
  // suffix or subdomain attack) or has no email is not a shadow user and must never name an identity.
  it.each<[string, string | null]>([
    ['an embedded-@ lookalike', `attacker@evil.com@${SHADOW_EMAIL_DOMAIN}`],
    ['the reserved domain as a prefix', `abc@${SHADOW_EMAIL_DOMAIN}.attacker.com`],
    ['a subdomain of the reserved domain', `abc@sub.${SHADOW_EMAIL_DOMAIN}`],
    ['an empty local part', `@${SHADOW_EMAIL_DOMAIN}`],
    ['a docmost-native anchor address', 'docmost-native+x@users.invalid'],
    ['a null email', null],
  ])('answers null externalId for %s', async (_label, email) => {
    const spy = spyKysely(() => [{ workspace_id: 'ws1', email }]);
    await expect(new WorkspaceResolver(spy.db).resolveUser('user-42')).resolves.toEqual({
      workspaceId: 'ws1',
      externalId: null,
    });
  });

  it('404s an unknown user id', async () => {
    const spy = spyKysely(() => []);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUser('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  // F5 (companion #272): a soft-deleted user must not anchor a PDP grant, and (#871) a deleted shadow user must not
  // name an identity either. The fake database holds a deleted shadow row and honours the query's own filter: drop
  // the `deleted_at is null` predicate and the row comes back, so this goes red.
  it('F5: 404s a soft-deleted user, even a shadow one (the query filters deleted_at is null)', async () => {
    const deletedShadow = { workspace_id: 'ws1', email: SHADOW, deleted_at: '2026-11-01T00:00:00.000Z' };
    const spy = spyKysely((q) => (/deleted_at is null/i.test(q.sql) ? [] : [deletedShadow]));
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUser('user-42')).rejects.toBeInstanceOf(NotFoundException);
    expect(spy.calls[0].sql.toLowerCase()).toContain('deleted_at is null');
  });

  // F5: a row with a NULL workspace_id (the column is nullable) must 404, never return null typed as string (a bogus
  // PDP anchor is worse than a clean not-found) — and a shadow email on that row must not rescue it.
  it.each([null, SHADOW])('F5: 404s a user whose workspace_id is null (email %s)', async (email) => {
    const spy = spyKysely(() => [{ workspace_id: null, email }]);
    const r = new WorkspaceResolver(spy.db);
    await expect(r.resolveUser('ghost-ws')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * #871: `POST /api/service/users/resolve` answers exactly `{ userId, workspaceId, externalId }` (the documented
 * ResolvedUser), echoing the requested id and passing the resolver's `externalId` through unchanged, null included.
 * The key set is also pinned against the document by service-bridge.contract.spec.ts; this pins the values.
 */
describe('ServiceBridgeController.resolveUser (#871)', () => {
  const controllerWith = (resolveUser: WorkspaceResolver['resolveUser']) => {
    const workspaces = { resolveUser: jest.fn(resolveUser) };
    const controller = new ServiceBridgeController({} as any, {} as any, workspaces as any, {} as any);
    return { controller, workspaces };
  };

  it('returns the shadow user\'s identity as externalId', async () => {
    const { controller, workspaces } = controllerWith(async () => ({ workspaceId: 'ws1', externalId: 'ext-abc' }));
    await expect(controller.resolveUser({ userId: 'user-42' })).resolves.toStrictEqual({
      userId: 'user-42',
      workspaceId: 'ws1',
      externalId: 'ext-abc',
    });
    expect(workspaces.resolveUser).toHaveBeenCalledWith('user-42');
  });

  it('sends externalId: null (present, not omitted) for any other user', async () => {
    const { controller } = controllerWith(async () => ({ workspaceId: 'ws1', externalId: null }));
    const body = await controller.resolveUser({ userId: 'user-7' });
    expect(body).toStrictEqual({ userId: 'user-7', workspaceId: 'ws1', externalId: null });
    expect(Object.keys(body).sort()).toEqual(['externalId', 'userId', 'workspaceId']);
  });

  it('propagates the resolver\'s 404', async () => {
    const { controller } = controllerWith(async () => {
      throw new NotFoundException('user not found');
    });
    await expect(controller.resolveUser({ userId: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

// Small helper so a test can grab both the resolver and its spy.
function makeResolver(rows: unknown[]) {
  const spy = spyKysely(() => rows);
  return { resolver: new WorkspaceResolver(spy.db), spy };
}
