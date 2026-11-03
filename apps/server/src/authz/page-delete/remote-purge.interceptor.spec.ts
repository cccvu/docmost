import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

// The service module's graph reaches PageService, which pulls in the collab WebSocket stack (lib0 ESM). Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { NATIVE_PURGE_ROUTES, RemotePurgeInterceptor } from './remote-purge.interceptor';

/**
 * #636 W6 — `RemotePurgeInterceptor` in isolation: exactly when it takes over the native delete. The HTTP boundary (the
 * real PageController, ValidationPipe, the envelope) is `remote-purge-http.spec.ts`.
 */
class PageController {
  delete() {}
  restore() {}
}
class OtherController {
  delete() {}
}
const USER = { id: 'user-1' };
const WORKSPACE = { id: 'ws-1' };

const ctx = (opts: { cls?: new () => object; handler?: string; type?: string; body?: unknown; user?: unknown } = {}) => {
  const cls = opts.cls ?? PageController;
  const handler = (cls.prototype as Record<string, () => void>)[opts.handler ?? 'delete'];
  const res = { statusCode: 200 };
  const req = { body: 'body' in opts ? opts.body : { pageId: 'page-1', permanentlyDelete: true }, user: 'user' in opts ? opts.user : { user: USER, workspace: WORKSPACE } };
  return {
    getType: () => opts.type ?? 'http',
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
};

const build = (mode: 'native' | 'remote', purge: (...a: unknown[]) => Promise<unknown> = async () => ({})) => {
  const service = { purge: jest.fn(purge) };
  const next = { handle: jest.fn(() => of('handler-result')) };
  const interceptor = new RemotePurgeInterceptor(mode, service as never, new Reflector());
  return { interceptor, service, next };
};

describe('RemotePurgeInterceptor', () => {
  it('is keyed to the native delete only', () => {
    expect([...NATIVE_PURGE_ROUTES]).toEqual(['PageController.delete']);
  });

  it('remote + permanentlyDelete:true → the purge for the caller, page and workspace; the handler is never called; the envelope is upstream’s', async () => {
    const t = build('remote');
    await expect(firstValueFrom(t.interceptor.intercept(ctx(), t.next))).resolves.toEqual({
      data: undefined,
      success: true,
      status: 200,
    });
    expect(t.service.purge).toHaveBeenCalledWith(USER, 'page-1', 'ws-1');
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
    ['a non-http context', 'remote' as const, { type: 'ws' }],
    ['a sibling handler', 'remote' as const, { handler: 'restore' }],
    ['the same handler name on another class', 'remote' as const, { cls: OtherController }],
    ['a trash (absent flag)', 'remote' as const, { body: { pageId: 'page-1' } }],
    ['a trash (false)', 'remote' as const, { body: { pageId: 'page-1', permanentlyDelete: false } }],
    ['a trash (null)', 'remote' as const, { body: { pageId: 'page-1', permanentlyDelete: null } }],
    ['a null body (the pipe refuses it)', 'remote' as const, { body: null }],
    ['an array body (the pipe refuses it)', 'remote' as const, { body: [{ pageId: 'p', permanentlyDelete: true }] }],
  ])('passes through: %s', async (_l, mode, o) => {
    const t = build(mode);
    await expect(firstValueFrom(t.interceptor.intercept(ctx(o), t.next))).resolves.toBe('handler-result');
    expect(t.service.purge).not.toHaveBeenCalled();
  });

  it.each([
    ['a string flag', { pageId: 'page-1', permanentlyDelete: 'true' }],
    ['a numeric flag', { pageId: 'page-1', permanentlyDelete: 1 }],
    ['an object flag', { pageId: 'page-1', permanentlyDelete: {} }],
    ['no pageId', { permanentlyDelete: true }],
    ['an empty pageId', { pageId: '', permanentlyDelete: true }],
    ['a non-string pageId', { pageId: ['page-1'], permanentlyDelete: true }],
  ])('fails closed with a 400 on %s: neither the purge nor the handler', async (_l, body) => {
    const t = build('remote');
    await expect(firstValueFrom(t.interceptor.intercept(ctx({ body }), t.next))).rejects.toBeInstanceOf(BadRequestException);
    expect(t.service.purge).not.toHaveBeenCalled();
    expect(t.next.handle).not.toHaveBeenCalled();
  });

  it('no authenticated user → 401, never a purge without a subject', async () => {
    for (const user of [undefined, { user: {}, workspace: WORKSPACE }, { user: USER, workspace: {} }]) {
      const t = build('remote');
      await expect(firstValueFrom(t.interceptor.intercept(ctx({ user }), t.next))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(t.service.purge).not.toHaveBeenCalled();
    }
  });
});
