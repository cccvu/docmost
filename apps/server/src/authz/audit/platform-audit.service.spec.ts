import { NoopAuditService } from '../../integrations/audit/audit.service';
import { StandaloneAuditService } from './activity-audit.writer';
import { createAuditService } from './audit.module';
import { PlatformAuditClient } from './platform-audit.client';
import { PlatformAuditService } from './platform-audit.service';

/**
 * CCC audit integration test (part of the fork's compatibility suite). Proves the forwarder is
 * fire-and-forget (never throws) and that the service maps the upstream payload + CLS context onto the
 * ingest contract.
 */
describe('PlatformAuditClient (fire-and-forget forwarder)', () => {
  let client: PlatformAuditClient;
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.PLATFORM_AUTHZ_URL = 'http://platform.test';
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'sekret';
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    fetchMock.mockReset();
    client = new PlatformAuditClient();
  });

  const evt = { event: 'page.restricted', resourceType: 'page', resourceId: 'pg1', workspaceId: 'w1' };

  it('posts the batch to /audit/ingest with the service secret', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}) });
    await client.forward([evt]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://platform.test/audit/ingest');
    expect(init.headers['x-authz-service-secret']).toBe('sekret');
    expect(JSON.parse(init.body)).toEqual({ events: [evt] });
  });

  it('skips the call on an empty batch', async () => {
    await client.forward([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws on a non-200 (drops, does not block the request)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(client.forward([evt])).resolves.toBeUndefined();
  });

  it('never throws on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client.forward([evt])).resolves.toBeUndefined();
  });

  /**
   * The dropped-batch warning is the ONLY signal that forwarded audit is being lost — the forward is
   * fire-and-forget, so a systematic rejection drops every event while the request path stays healthy.
   * A CloudWatch metric filter keys on the bare token, so the alarm's entire trigger is this substring:
   * reword the line without it and the alarm goes quietly dead while still reading OK. A whole-file grep
   * (check-infra-config §14b) proves the token EXISTS somewhere; only this proves the failure path emits it.
   */
  it.each([
    ['a rejected batch', () => fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })],
    ['an unreachable sink', () => fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))],
  ])('emits the AUDIT_FORWARD_FAILED alarm token on %s', async (_name, arrange) => {
    const warn = jest.spyOn((client as unknown as { logger: { warn: jest.Mock } }).logger, 'warn').mockImplementation();
    arrange();
    await client.forward([evt]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('AUDIT_FORWARD_FAILED');
    warn.mockRestore();
  });
});

describe('PlatformAuditService (AUDIT_SERVICE rebind)', () => {
  const makeCls = (ctx: Record<string, unknown> | undefined) => {
    const store = ctx;
    return {
      get: jest.fn(() => store),
      set: jest.fn(),
      _ctx: store,
    };
  };
  const makeClient = () => ({ forward: jest.fn(async (_events: any) => undefined) });

  const ctx = {
    workspaceId: 'w1',
    actorId: 'dm-1',
    actorType: 'user' as const,
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
  };

  it('log() maps the payload + CLS context onto one ingest event', () => {
    const cls = makeCls({ ...ctx });
    const client = makeClient();
    const svc = new PlatformAuditService(cls as any, client as any);

    svc.log({ event: 'page.deleted', resourceType: 'page', resourceId: 'pg1', spaceId: 'sp1' });

    expect(client.forward).toHaveBeenCalledTimes(1);
    expect(client.forward.mock.calls[0][0]).toEqual([
      {
        event: 'page.deleted',
        resourceType: 'page',
        resourceId: 'pg1',
        spaceId: 'sp1',
        changes: undefined,
        metadata: undefined,
        actorId: 'dm-1',
        actorType: 'user',
        workspaceId: 'w1',
        ipAddress: '10.0.0.1',
        userAgent: 'jest',
      },
    ]);
  });

  it('logWithContext() uses the explicit context over the CLS one', () => {
    const cls = makeCls(undefined);
    const client = makeClient();
    const svc = new PlatformAuditService(cls as any, client as any);

    svc.logWithContext(
      { event: 'user.login', resourceType: 'user', resourceId: 'u9' },
      { workspaceId: 'w2', actorId: 'u9', actorType: 'user' },
    );
    expect(client.forward.mock.calls[0][0][0]).toMatchObject({ workspaceId: 'w2', actorId: 'u9' });
  });

  it('logBatchWithContext() forwards one event per payload', () => {
    const cls = makeCls(undefined);
    const client = makeClient();
    const svc = new PlatformAuditService(cls as any, client as any);

    svc.logBatchWithContext(
      [
        { event: 'page.imported', resourceType: 'page', resourceId: 'a' },
        { event: 'page.imported', resourceType: 'page', resourceId: 'b' },
      ],
      { workspaceId: 'w1', actorId: 'imp', actorType: 'system' },
    );
    expect(client.forward.mock.calls[0][0]).toHaveLength(2);
  });

  it('setActorId / setActorType persist into the CLS context the next log reads', () => {
    const store: Record<string, unknown> = { ...ctx };
    const cls = { get: jest.fn(() => store), set: jest.fn() };
    const svc = new PlatformAuditService(cls as any, makeClient() as any);

    svc.setActorId('new-actor');
    svc.setActorType('api_key');
    expect(store.actorId).toBe('new-actor');
    expect(store.actorType).toBe('api_key');
    expect(cls.set).toHaveBeenCalled();
  });

  it('tolerates a missing CLS context (forwards with undefined actor fields)', () => {
    const cls = makeCls(undefined);
    const client = makeClient();
    const svc = new PlatformAuditService(cls as any, client as any);

    svc.log({ event: 'workspace.created', resourceType: 'workspace', resourceId: 'w1' });
    expect(client.forward.mock.calls[0][0][0]).toMatchObject({ actorId: undefined, workspaceId: undefined });
    // setActorId with no context is a safe no-op.
    expect(() => svc.setActorId('x')).not.toThrow();
  });
});

/**
 * #615: the local activity copy rides alongside the forward and must never change it. The writer's own rules
 * (allowlist, skips, never rejects) are in activity-audit.writer.spec.ts; these pin the SERVICE's half: every
 * log path hands the writer the same context it forwards with, the forward is issued first and is identical
 * with or without a writer, and a failing writer never reaches the request path.
 */
describe('PlatformAuditService local activity copy (#615)', () => {
  const ctx = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    actorId: '22222222-2222-4222-8222-222222222222',
    actorType: 'user' as const,
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
  };
  const payload = {
    event: 'page.trashed',
    resourceType: 'page',
    resourceId: '33333333-3333-4333-8333-333333333333',
    spaceId: '44444444-4444-4444-8444-444444444444',
  } as const;
  const makeCls = () => ({ get: jest.fn(() => ({ ...ctx })), set: jest.fn() });
  const makeClient = () => ({ forward: jest.fn(async (_events: any) => undefined) });
  const makeWriter = () => ({ record: jest.fn(async (_p: any, _c: any) => undefined) });

  it('log() records the payload with the CLS actor context, after issuing the forward', () => {
    const order: string[] = [];
    const client = { forward: jest.fn(async () => void order.push('forward')) };
    const writer = { record: jest.fn(async () => void order.push('record')) };
    new PlatformAuditService(makeCls() as any, client as any, writer as any).log(payload as any);

    expect(writer.record).toHaveBeenCalledTimes(1);
    const [payloads, context] = writer.record.mock.calls[0] as unknown as [unknown[], Record<string, unknown>];
    expect(payloads).toEqual([payload]);
    expect(context).toMatchObject({ workspaceId: ctx.workspaceId, actorId: ctx.actorId, actorType: 'user' });
    expect(order).toEqual(['forward', 'record']);
  });

  it('logWithContext / logBatchWithContext record with the caller-supplied context', () => {
    const writer = makeWriter();
    const svc = new PlatformAuditService(makeCls() as any, makeClient() as any, writer as any);
    const explicit = { workspaceId: ctx.workspaceId, actorId: ctx.actorId, actorType: 'system' as const };

    svc.logWithContext(payload as any, explicit);
    svc.logBatchWithContext([payload as any, { ...payload, event: 'page.restored' } as any], explicit);

    expect(writer.record).toHaveBeenNthCalledWith(1, [payload], explicit);
    expect(writer.record).toHaveBeenNthCalledWith(2, [payload, { ...payload, event: 'page.restored' }], explicit);
  });

  it('forwards exactly the same events with or without the writer', () => {
    const withWriter = makeClient();
    const without = makeClient();
    const a = new PlatformAuditService(makeCls() as any, withWriter as any, makeWriter() as any);
    const b = new PlatformAuditService(makeCls() as any, without as any);
    const explicit = { workspaceId: 'w1', actorId: 'u1', actorType: 'user' as const, ipAddress: '9.9.9.9' };

    a.log(payload as any);
    b.log(payload as any);
    a.logWithContext(payload as any, explicit);
    b.logWithContext(payload as any, explicit);
    a.logBatchWithContext([payload as any], explicit);
    b.logBatchWithContext([payload as any], explicit);

    expect(withWriter.forward.mock.calls).toEqual(without.forward.mock.calls);
    // The IP still reaches the platform — only the local copy drops it.
    expect(withWriter.forward.mock.calls[0][0][0].ipAddress).toBe('10.0.0.1');
  });

  it.each([
    ['throws synchronously', () => { throw new Error('boom'); }],
    ['rejects', () => Promise.reject(new Error('boom'))],
    ['returns nothing', () => undefined],
  ])('never throws into the request path, and still forwards, when the writer %s', async (_name, record) => {
    const client = makeClient();
    const svc = new PlatformAuditService(makeCls() as any, client as any, { record } as any);
    expect(() => svc.log(payload as any)).not.toThrow();
    expect(() => svc.logWithContext(payload as any, { workspaceId: 'w1' })).not.toThrow();
    expect(() => svc.logBatchWithContext([payload as any], { workspaceId: 'w1' })).not.toThrow();
    expect(client.forward).toHaveBeenCalledTimes(3);
    await new Promise((r) => setImmediate(r)); // a swallowed rejection must not surface as an unhandled one
  });
});

describe('createAuditService (the AUDIT_SERVICE factory)', () => {
  const ctx = { workspaceId: '11111111-1111-4111-8111-111111111111', actorId: null, actorType: 'user' };
  const payload = { event: 'page.restored', resourceType: 'page', resourceId: '33333333-3333-4333-8333-333333333333' };

  it('remote → PlatformAuditService, forwarding AND recording the activity copy', () => {
    const client = { forward: jest.fn(async () => undefined) };
    const writer = { record: jest.fn(async () => undefined) };
    const svc = createAuditService('remote', { get: () => ctx, set: jest.fn() } as any, client as any, writer as any);
    expect(svc).toBeInstanceOf(PlatformAuditService);
    svc.log(payload as any);
    expect(client.forward).toHaveBeenCalledTimes(1);
    expect(writer.record).toHaveBeenCalledTimes(1);
  });

  it('native → the standalone service: records the activity copy, forwards nothing', () => {
    const client = { forward: jest.fn(async () => undefined) };
    const writer = { record: jest.fn(async () => undefined) };
    const svc = createAuditService('native', { get: () => ctx, set: jest.fn() } as any, client as any, writer as any);
    expect(svc).toBeInstanceOf(StandaloneAuditService);
    expect(svc).toBeInstanceOf(NoopAuditService);
    svc.log(payload as any);
    expect(client.forward).not.toHaveBeenCalled();
    expect(writer.record).toHaveBeenCalledTimes(1);
  });
});
