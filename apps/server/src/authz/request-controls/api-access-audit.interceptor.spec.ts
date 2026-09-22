import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { ApiAccessAuditInterceptor } from './api-access-audit.interceptor';
import { ApiAccessAuditService } from './api-access-audit.service';
import type { AuditIngestEvent } from '../audit/platform-audit.client';

/**
 * Unit suite for the per-request `/api` access-audit interceptor (#467) — NOT upstream Docmost code.
 *
 * Proves: exactly one #320-clean `access` row per authenticated request with the right shape and priority;
 * @Public / no-principal / excluded / mutations-only requests are skipped; a 429 (or any downstream error) is
 * still audited with the right status; forwarding is fire-and-forget (a failing forward never fails the
 * request); and native mode (no central sink) is a no-op.
 */

function makeService(mode: 'remote' | 'native' = 'remote', env?: Record<string, string>) {
  const saved = { API_AUDIT_ENABLED: process.env.API_AUDIT_ENABLED };
  if (env?.API_AUDIT_ENABLED !== undefined) process.env.API_AUDIT_ENABLED = env.API_AUDIT_ENABLED;
  const forward = jest.fn(async (_events: AuditIngestEvent[]) => undefined);
  const svc = new ApiAccessAuditService(mode as never, { forward } as never);
  process.env.API_AUDIT_ENABLED = saved.API_AUDIT_ENABLED; // enabled is read at construction; restore now
  const events = () => forward.mock.calls.flatMap((c) => c[0]);
  return { svc, forward, events };
}

function makeCtx(opts: {
  method?: string;
  url?: string;
  user?: unknown;
  isPublic?: boolean;
  remoteAddress?: string;
  statusCode?: number;
}): { ctx: ExecutionContext; reflector: Reflector } {
  const req = {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/api/pages/info?x=1',
    headers: { 'user-agent': 'jest' },
    user: opts.user,
    raw: { socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.5' }, headers: {} },
  };
  const res = { statusCode: opts.statusCode ?? 200 };
  const handler = () => undefined;
  class Cls {}
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Cls,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  const reflector = { getAllAndOverride: () => !!opts.isPublic } as unknown as Reflector;
  return { ctx, reflector };
}

const handlerOf = (obs: unknown): CallHandler => ({ handle: () => obs as never });
const AUTHED = { user: { id: 'u1' }, workspace: { id: 'ws1' } };

describe('ApiAccessAuditInterceptor (#467)', () => {
  const ENV_KEYS = ['API_AUDIT_MUTATIONS_ONLY', 'API_AUDIT_EXCLUDE_ROUTES', 'API_AUDIT_ENABLED'] as const;
  const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
    jest.restoreAllMocks();
  });

  it('emits exactly one #320-clean access row for an authenticated READ (priority low)', async () => {
    const { svc, events } = makeService();
    const { ctx, reflector } = makeCtx({ method: 'GET', user: AUTHED });
    const it = new ApiAccessAuditInterceptor(reflector, svc);
    await lastValueFrom(it.intercept(ctx, handlerOf(of({ ok: true }))));

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      event: 'api.get',
      resourceType: 'http_request',
      eventCategory: 'access',
      priority: 'low',
      actorId: 'u1',
      actorType: 'user',
      workspaceId: 'ws1',
      clientEvidence: { socketPeer: '203.0.113.5' }, // resolved by the platform, not a client-supplied IP
    });
    expect(events()[0].metadata).toMatchObject({ route: '/api/pages/info', method: 'GET', status: 200, outcome: 'success' });
    // never the query string, body, or auth headers
    expect(JSON.stringify(events()[0])).not.toContain('x=1');
  });

  it('marks a mutation (POST) priority normal', async () => {
    const { svc, events } = makeService();
    const { ctx, reflector } = makeCtx({ method: 'POST', url: '/api/pages/update', user: AUTHED });
    await lastValueFrom(new ApiAccessAuditInterceptor(reflector, svc).intercept(ctx, handlerOf(of({}))));
    expect(events()[0]).toMatchObject({ event: 'api.post', priority: 'normal' });
  });

  it('audits a 429 (or any downstream error) with the thrown status', async () => {
    const { svc, events } = makeService();
    const { ctx, reflector } = makeCtx({ method: 'POST', url: '/api/pages/update', user: AUTHED });
    const it = new ApiAccessAuditInterceptor(reflector, svc);
    await expect(
      lastValueFrom(it.intercept(ctx, handlerOf(throwError(() => new HttpException('too many', 429))))),
    ).rejects.toBeInstanceOf(HttpException);
    expect(events()[0].metadata).toMatchObject({ status: 429, outcome: 'error' });
  });

  it('skips @Public, no-principal (east-west), and env-excluded routes', async () => {
    // @Public
    let s = makeService();
    await lastValueFrom(
      new ApiAccessAuditInterceptor(makeCtx({ user: AUTHED, isPublic: true }).reflector, s.svc).intercept(
        makeCtx({ user: AUTHED, isPublic: true }).ctx,
        handlerOf(of({})),
      ),
    );
    expect(s.forward).not.toHaveBeenCalled();

    // no principal (service/collab east-west shape)
    s = makeService();
    const noUser = makeCtx({ user: undefined });
    await lastValueFrom(new ApiAccessAuditInterceptor(noUser.reflector, s.svc).intercept(noUser.ctx, handlerOf(of({}))));
    expect(s.forward).not.toHaveBeenCalled();

    // env-excluded prefix
    process.env.API_AUDIT_EXCLUDE_ROUTES = '/api/notifications';
    s = makeService();
    const excluded = makeCtx({ url: '/api/notifications/unread', user: AUTHED });
    await lastValueFrom(new ApiAccessAuditInterceptor(excluded.reflector, s.svc).intercept(excluded.ctx, handlerOf(of({}))));
    expect(s.forward).not.toHaveBeenCalled();
  });

  it('mutations-only mode skips reads but keeps mutations', async () => {
    process.env.API_AUDIT_MUTATIONS_ONLY = 'true';
    const s = makeService();
    const read = makeCtx({ method: 'GET', user: AUTHED });
    await lastValueFrom(new ApiAccessAuditInterceptor(read.reflector, s.svc).intercept(read.ctx, handlerOf(of({}))));
    expect(s.forward).not.toHaveBeenCalled();

    const write = makeCtx({ method: 'DELETE', url: '/api/pages/x', user: AUTHED });
    await lastValueFrom(new ApiAccessAuditInterceptor(write.reflector, s.svc).intercept(write.ctx, handlerOf(of({}))));
    expect(s.forward).toHaveBeenCalledTimes(1);
  });

  it('is fire-and-forget: a failing forward never fails the request', async () => {
    const forward = jest.fn(async () => {
      throw new Error('platform down');
    });
    const svc = new ApiAccessAuditService('remote' as never, { forward } as never);
    const { ctx, reflector } = makeCtx({ user: AUTHED });
    await expect(
      lastValueFrom(new ApiAccessAuditInterceptor(reflector, svc).intercept(ctx, handlerOf(of({ ok: true })))),
    ).resolves.toEqual({ ok: true });
  });

  it('native mode (no central sink) is a no-op', async () => {
    const s = makeService('native');
    expect(s.svc.enabled).toBe(false);
    const { ctx, reflector } = makeCtx({ user: AUTHED });
    await lastValueFrom(new ApiAccessAuditInterceptor(reflector, s.svc).intercept(ctx, handlerOf(of({}))));
    expect(s.forward).not.toHaveBeenCalled();
  });

  it('API_AUDIT_ENABLED=false disables it even in remote mode', async () => {
    const s = makeService('remote', { API_AUDIT_ENABLED: 'false' });
    expect(s.svc.enabled).toBe(false);
  });
});
