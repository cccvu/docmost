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
