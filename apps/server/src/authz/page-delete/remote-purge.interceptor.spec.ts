import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

// The service module's graph reaches PageService, which pulls in the collab WebSocket stack (lib0 ESM). Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { NATIVE_PURGE_ROUTES, NATIVE_RESTORE_ROUTES, RemotePurgeInterceptor } from './remote-purge.interceptor';

/**
 * #636 W6 / #556 — `RemotePurgeInterceptor` in isolation: exactly when it takes over the native delete and restore.
 * The HTTP boundary (the real PageController, ValidationPipe, the envelope) is `remote-purge-http.spec.ts`.
 */
class PageController {
  delete() {}
  restore() {}
  move() {}
}
class OtherController {
  delete() {}
  restore() {}
}
const USER = { id: 'user-1' };
const WORKSPACE = { id: 'ws-1' };

const ctx = (
  opts: { cls?: new () => object; handler?: string; type?: string; body?: unknown; user?: unknown; headers?: Record<string, unknown> } = {},
) => {
  const cls = opts.cls ?? PageController;
  const handler = (cls.prototype as Record<string, () => void>)[opts.handler ?? 'delete'];
  const res = { statusCode: 200 };
  const req = {
    body: 'body' in opts ? opts.body : { pageId: 'page-1', permanentlyDelete: true },
    user: 'user' in opts ? opts.user : { user: USER, workspace: WORKSPACE },
    headers: opts.headers ?? {},
  };
  return {
    getType: () => opts.type ?? 'http',
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
};

const build = (
  mode: 'native' | 'remote',
  purge: (...a: unknown[]) => Promise<unknown> = async () => ({}),
  trash: (...a: unknown[]) => Promise<unknown> = async () => ({ outcome: 'applied', page: { id: 'page-1' } }),
  restore: (...a: unknown[]) => Promise<unknown> = async () => ({ outcome: 'applied', page: RESTORED }),
) => {
  const service = { purge: jest.fn(purge) };
  const trashService = { trash: jest.fn(trash) };
  const restoreService = { restore: jest.fn(restore) };
  const next = { handle: jest.fn(() => of('handler-result')) };
  const interceptor = new RemotePurgeInterceptor(
    mode,
    service as never,
    trashService as never,
    restoreService as never,
    new Reflector(),
  );
  return { interceptor, service, trashService, restoreService, next };
};
const RESTORED = { id: 'page-1', slugId: 'slug-1', hasChildren: false };
const SA = '0198c2a1-0000-7000-8000-00000000005a';

describe('RemotePurgeInterceptor', () => {
  it('is keyed to the native delete and the native restore only', () => {
    expect([...NATIVE_PURGE_ROUTES]).toEqual(['PageController.delete']);
    expect([...NATIVE_RESTORE_ROUTES]).toEqual(['PageController.restore']);
  });

  it('remote + permanentlyDelete:true → the purge for the caller, page and workspace; the handler is never called; the envelope is upstream’s', async () => {
    const t = build('remote');
    await expect(firstValueFrom(t.interceptor.intercept(ctx(), t.next))).resolves.toEqual({
      data: undefined,
      success: true,
      status: 200,
    });
    expect(t.service.purge).toHaveBeenCalledWith(USER, 'page-1', 'ws-1', undefined, undefined);
    expect(t.trashService.trash).not.toHaveBeenCalled();
    expect(t.next.handle).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', { pageId: 'page-1' }],
    ['false', { pageId: 'page-1', permanentlyDelete: false }],
    ['null', { pageId: 'page-1', permanentlyDelete: null }],
  ])('remote + a trash (flag %s) → the trash routine, never the handler; the envelope is upstream’s (#661)', async (_l, body) => {
    const t = build('remote');
    await expect(firstValueFrom(t.interceptor.intercept(ctx({ body }), t.next))).resolves.toEqual({
      data: undefined,
      success: true,
      status: 200,
    });
    expect(t.trashService.trash).toHaveBeenCalledWith(USER, 'page-1', 'ws-1', undefined, undefined);
    expect(t.service.purge).not.toHaveBeenCalled();
    expect(t.next.handle).not.toHaveBeenCalled();
  });

  it('a trash refusal propagates (and the handler still never runs)', async () => {
    const t = build('remote', undefined, async () => Promise.reject(new ForbiddenException({ code: 'trash_needs_edit' })));
    await expect(
      firstValueFrom(t.interceptor.intercept(ctx({ body: { pageId: 'page-1' } }), t.next)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.next.handle).not.toHaveBeenCalled();
  });

  it('a purge refusal propagates (and the handler still never runs)', async () => {
    const t = build('remote', async () => Promise.reject(new ForbiddenException({ code: 'purge_needs_edit' })));
    await expect(firstValueFrom(t.interceptor.intercept(ctx(), t.next))).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.next.handle).not.toHaveBeenCalled();
  });

  it('the purge starts only on subscription (a cold observable, never on intercept())', () => {
    const t = build('remote');
    t.interceptor.intercept(ctx(), t.next);
    expect(t.service.purge).not.toHaveBeenCalled();
  });

  it.each([
    ['native mode', 'native' as const, {}],
    ['native mode, a trash', 'native' as const, { body: { pageId: 'page-1' } }],
    ['native mode ignores the acting-service header, even a malformed one', 'native' as const, { headers: { 'x-ccc-acting-service': 'not-an-id' } }],
    ['a non-http context', 'remote' as const, { type: 'ws' }],
    ['a sibling handler', 'remote' as const, { handler: 'move' }],
    ['native mode, a restore', 'native' as const, { handler: 'restore', body: { pageId: 'page-1' } }],
    ['the restore handler name on another class', 'remote' as const, { cls: OtherController, handler: 'restore' }],
    ['the same handler name on another class', 'remote' as const, { cls: OtherController }],
  ])('passes through: %s', async (_l, mode, o) => {
    const t = build(mode);
    await expect(firstValueFrom(t.interceptor.intercept(ctx(o), t.next))).resolves.toBe('handler-result');
    expect(t.service.purge).not.toHaveBeenCalled();
    expect(t.trashService.trash).not.toHaveBeenCalled();
    expect(t.restoreService.restore).not.toHaveBeenCalled();
  });

  it.each([
    ['a string flag', { pageId: 'page-1', permanentlyDelete: 'true' }],
    ['a numeric flag', { pageId: 'page-1', permanentlyDelete: 1 }],
    ['an object flag', { pageId: 'page-1', permanentlyDelete: {} }],
    ['no pageId', { permanentlyDelete: true }],
    ['an empty pageId', { pageId: '', permanentlyDelete: true }],
    ['a non-string pageId', { pageId: ['page-1'], permanentlyDelete: true }],
    ['a trash with no pageId', {}],
    ['a trash with an empty pageId', { pageId: '' }],
    ['a trash with a non-string pageId', { pageId: 42, permanentlyDelete: false }],
    ['a null body', null],
    ['an array body', [{ pageId: 'p', permanentlyDelete: true }]],
  ])('fails closed with a 400 on %s: neither routine nor the handler', async (_l, body) => {
    const t = build('remote');
    await expect(firstValueFrom(t.interceptor.intercept(ctx({ body }), t.next))).rejects.toBeInstanceOf(BadRequestException);
    expect(t.service.purge).not.toHaveBeenCalled();
    expect(t.trashService.trash).not.toHaveBeenCalled();
    expect(t.next.handle).not.toHaveBeenCalled();
  });

  describe('the acting-service header (#670): parsed before either branch, passed only as the service leg', () => {
    it.each([
      ['a purge', { pageId: 'page-1', permanentlyDelete: true }, 'purge'],
      ['a trash', { pageId: 'page-1' }, 'trash'],
    ])('a valid id reaches %s as its service account', async (_l, body, which) => {
      const t = build('remote');
      await firstValueFrom(t.interceptor.intercept(ctx({ body, headers: { 'x-ccc-acting-service': SA } }), t.next));
      const fn = which === 'purge' ? t.service.purge : t.trashService.trash;
      expect(fn).toHaveBeenCalledWith(USER, 'page-1', 'ws-1', undefined, SA);
    });

    it.each([
      ['empty', ''],
      ['duplicated (an array)', [SA, SA]],
      ['duplicated (comma-joined)', `${SA}, ${SA}`],
      ['not a principal id', 'service-account-1'],
      ['padded', ` ${SA}`],
      ['a number', 42],
    ])('%s → 400 acting_service_invalid for a purge AND a trash; nothing runs', async (_l, value) => {
      for (const body of [{ pageId: 'page-1', permanentlyDelete: true }, { pageId: 'page-1' }]) {
        const t = build('remote');
        const err = await firstValueFrom(
          t.interceptor.intercept(ctx({ body, headers: { 'x-ccc-acting-service': value } }), t.next),
        ).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'acting_service_invalid' });
        expect(JSON.stringify((err as BadRequestException).getResponse())).not.toContain('service-account-1');
        expect(t.service.purge).not.toHaveBeenCalled();
        expect(t.trashService.trash).not.toHaveBeenCalled();
        expect(t.next.handle).not.toHaveBeenCalled();
      }
    });
  });

  describe('the native restore (#556)', () => {
    const restoreCtx = (o: Parameters<typeof ctx>[0] = {}) => ctx({ handler: 'restore', body: { pageId: 'page-1' }, ...o });

    it('remote → the restore routine for the caller, page and workspace; the handler never runs; the envelope carries the routine’s page', async () => {
      const t = build('remote');
      await expect(firstValueFrom(t.interceptor.intercept(restoreCtx(), t.next))).resolves.toEqual({
        data: RESTORED,
        success: true,
        status: 200,
      });
      expect(t.restoreService.restore).toHaveBeenCalledWith(USER, 'page-1', 'ws-1', undefined);
      expect(t.service.purge).not.toHaveBeenCalled();
      expect(t.trashService.trash).not.toHaveBeenCalled();
      expect(t.next.handle).not.toHaveBeenCalled();
    });

    it('a noop (a live page) answers its page the same way', async () => {
      const t = build('remote', undefined, undefined, async () => ({ outcome: 'noop', page: RESTORED }));
      await expect(firstValueFrom(t.interceptor.intercept(restoreCtx(), t.next))).resolves.toMatchObject({ data: RESTORED });
    });

    it('a restore refusal propagates, and the handler still never runs', async () => {
      const t = build('remote', undefined, undefined, async () => Promise.reject(new ForbiddenException({ code: 'restore_needs_edit' })));
      await expect(firstValueFrom(t.interceptor.intercept(restoreCtx(), t.next))).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.next.handle).not.toHaveBeenCalled();
    });

    it('starts only on subscription', () => {
      const t = build('remote');
      t.interceptor.intercept(restoreCtx(), t.next);
      expect(t.restoreService.restore).not.toHaveBeenCalled();
    });

    it('never reads the delete flag: an extra field the DTO whitelist would strip does not refuse a restore', async () => {
      const t = build('remote');
      await firstValueFrom(t.interceptor.intercept(restoreCtx({ body: { pageId: 'page-1', permanentlyDelete: 'yes' } }), t.next));
      expect(t.restoreService.restore).toHaveBeenCalledWith(USER, 'page-1', 'ws-1', undefined);
    });

    it.each([
      ['no pageId', {}],
      ['an empty pageId', { pageId: '' }],
      ['a non-string pageId', { pageId: 42 }],
      ['a null body', null],
      ['an array body', [{ pageId: 'page-1' }]],
    ])('fails closed with a 400 on %s: neither the routine nor the handler', async (_l, body) => {
      const t = build('remote');
      await expect(firstValueFrom(t.interceptor.intercept(restoreCtx({ body }), t.next))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(t.restoreService.restore).not.toHaveBeenCalled();
      expect(t.next.handle).not.toHaveBeenCalled();
    });

    it('the acting-service header: a valid id reaches the routine as its service account', async () => {
      const t = build('remote');
      await firstValueFrom(t.interceptor.intercept(restoreCtx({ headers: { 'x-ccc-acting-service': SA } }), t.next));
      expect(t.restoreService.restore).toHaveBeenCalledWith(USER, 'page-1', 'ws-1', SA);
    });

    it.each([
      ['empty', ''],
      ['duplicated (an array)', [SA, SA]],
      ['not a principal id', 'service-account-1'],
    ])('the acting-service header %s → 400 acting_service_invalid; nothing runs', async (_l, value) => {
      const t = build('remote');
      const err = await firstValueFrom(
        t.interceptor.intercept(restoreCtx({ headers: { 'x-ccc-acting-service': value } }), t.next),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'acting_service_invalid' });
      expect(t.restoreService.restore).not.toHaveBeenCalled();
      expect(t.next.handle).not.toHaveBeenCalled();
    });

    it('no authenticated user → 401', async () => {
      const t = build('remote');
      await expect(
        firstValueFrom(t.interceptor.intercept(restoreCtx({ user: undefined }), t.next)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(t.restoreService.restore).not.toHaveBeenCalled();
    });
  });

  it('no authenticated user → 401, never a purge without a subject', async () => {
    for (const user of [undefined, { user: {}, workspace: WORKSPACE }, { user: USER, workspace: {} }]) {
      const t = build('remote');
      await expect(firstValueFrom(t.interceptor.intercept(ctx({ user }), t.next))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(t.service.purge).not.toHaveBeenCalled();
      expect(t.trashService.trash).not.toHaveBeenCalled();
    }
  });
});
