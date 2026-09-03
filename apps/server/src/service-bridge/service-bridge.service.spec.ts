import { ForbiddenException } from '@nestjs/common';
import { ServiceBridgeService } from './service-bridge.service';
import { shadowEmailFor } from './shadow-user';

const shadow = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: shadowEmailFor('id-123'),
  role: 'member',
  deletedAt: null,
  ...over,
});

function makeService(user: unknown) {
  const userRepo = { findById: jest.fn(async () => user) } as any;
  const sessionService = {
    createSessionAndToken: jest.fn(async () => 'authtoken-xyz'),
  } as any;
  const svc = new ServiceBridgeService({} as any, userRepo, sessionService);
  return { svc, sessionService };
}

describe('ServiceBridgeService.mintSession — no generic impersonation', () => {
  it('mints a session for a fork-owned shadow member', async () => {
    const { svc, sessionService } = makeService(shadow());
    await expect(svc.mintSession('u1', 'ws1')).resolves.toBe('authtoken-xyz');
    expect(sessionService.createSessionAndToken).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing user (403, no token minted)', async () => {
    const { svc, sessionService } = makeService(undefined);
    await expect(svc.mintSession('u1', 'ws1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('refuses a PRIVILEGED (non-member) user — never mints an admin/owner session', async () => {
    const { svc, sessionService } = makeService(shadow({ role: 'admin' }));
    await expect(svc.mintSession('u1', 'ws1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('refuses a user OUTSIDE the shadow namespace (a real account)', async () => {
    const { svc } = makeService(shadow({ email: 'real.person@vanderbilt.edu' }));
    await expect(svc.mintSession('u1', 'ws1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a deleted user', async () => {
    const { svc } = makeService(shadow({ deletedAt: new Date() }));
    await expect(svc.mintSession('u1', 'ws1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ServiceBridgeService.provisionShadowUser', () => {
  it('upserts a plain MEMBER with the fork-derived synthetic email', async () => {
    const executeTakeFirstOrThrow = jest.fn(async () => ({ id: 'new-id' }));
    const returning = jest.fn(() => ({ executeTakeFirstOrThrow }));
    const onConflict = jest.fn((cb: any) => {
      cb({ columns: () => ({ doUpdateSet: () => ({}) }) });
      return { returning };
    });
    const values = jest.fn((..._args: unknown[]) => ({ onConflict }));
    const insertInto = jest.fn(() => ({ values }));
    const db = { insertInto } as any;
    const svc = new ServiceBridgeService(db, {} as any, {} as any);

    const id = await svc.provisionShadowUser({
      externalId: 'id-123',
      workspaceId: 'ws1',
    } as any);

    expect(id).toBe('new-id');
    expect(insertInto).toHaveBeenCalledWith('users');
    const vals = values.mock.calls[0][0] as Record<string, unknown>;
    expect(vals.email).toBe(shadowEmailFor('id-123'));
    expect(vals.role).toBe('member'); // never elevated
    expect(vals.workspaceId).toBe('ws1');
    expect(typeof vals.password).toBe('string'); // an (unusable) hash, not null
  });
});
