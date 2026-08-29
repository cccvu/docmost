import { PlatformAuthzClient } from './platform-authz.client';

/**
 * CCC authorization integration test (part of the fork's compatibility suite).
 * Proves the client is FAIL-CLOSED and shapes requests/responses correctly.
 */
describe('PlatformAuthzClient', () => {
  let client: PlatformAuthzClient;
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.PLATFORM_AUTHZ_URL = 'http://platform.test';
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'sekret';
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    fetchMock.mockReset();
    client = new PlatformAuthzClient();
  });

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it('sends the service secret and returns the PDP decision', async () => {
    fetchMock.mockResolvedValueOnce(ok({ allowed: true }));
    const allowed = await client.check({ provider: 'docmost', externalId: 'u1' }, 'view', 'space', 's1');
    expect(allowed).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://platform.test/authz/check');
    expect(init.headers['x-authz-service-secret']).toBe('sekret');
    expect(JSON.parse(init.body)).toMatchObject({ permission: 'view', resourceType: 'space', resourceId: 's1' });
  });

  it('is FAIL-CLOSED on a non-200 (denies)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    expect(await client.check({ principalId: 'p1' }, 'view', 'page', 'x')).toBe(false);
  });

  it('is FAIL-CLOSED on a network error (denies)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await client.check({ principalId: 'p1' }, 'view', 'page', 'x')).toBe(false);
  });

  it('checkBulk fails closed to all-false on error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await client.checkBulk({ principalId: 'p1' }, [
      { permission: 'view', resourceType: 'space', resourceId: 's1' },
      { permission: 'edit', resourceType: 'space', resourceId: 's1' },
    ])).toEqual([false, false]);
  });

  it('filterResources returns none on error and skips the call when empty', async () => {
    expect(await client.filterResources({ principalId: 'p1' }, 'view', 'page', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(ok({ ids: ['a', 'c'] }));
    expect(await client.filterResources({ principalId: 'p1' }, 'view', 'page', ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('filterSubjects wraps candidate ids, echoes the passing externalIds, and skips the call when empty', async () => {
    expect(await client.filterSubjects('view', 'page', 'pg1', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      ok({ subjects: [{ provider: 'docmost', externalId: 'u1' }, { provider: 'docmost', externalId: 'u3' }] }),
    );
    const allowed = await client.filterSubjects('view', 'page', 'pg1', ['u1', 'u2', 'u3']);
    expect(allowed).toEqual(['u1', 'u3']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://platform.test/authz/filter-subjects');
    expect(JSON.parse(init.body)).toMatchObject({
      permission: 'view',
      resourceType: 'page',
      resourceId: 'pg1',
      candidates: [
        { provider: 'docmost', externalId: 'u1' },
        { provider: 'docmost', externalId: 'u2' },
        { provider: 'docmost', externalId: 'u3' },
      ],
    });
  });

  it('filterSubjects is FAIL-CLOSED on error (denies all)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await client.filterSubjects('view', 'space', 's1', ['u1', 'u2'])).toEqual([]);
  });
});
