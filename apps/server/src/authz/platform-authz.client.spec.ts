import { PlatformAuthzClient, sanitizeAuthzTimeoutMs } from './platform-authz.client';

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

  // A well-formed HTTP 200 with a WRONG-TYPED body (a buggy or Byzantine platform) must still fail closed —
  // never allow, never let a non-array flow downstream as if it were the expected shape. The response-shape
  // guards in the client enforce this (transport errors are already covered above).
  describe('malformed 200 (Byzantine PDP) → fail-closed', () => {
    it('check: a non-boolean `allowed` is not an allow', async () => {
      fetchMock.mockResolvedValueOnce(ok({ allowed: 'yes' }));
      expect(await client.check({ principalId: 'p1' }, 'view', 'page', 'x')).toBe(false);
    });

    it('checkBulk: a non-array `results` denies the whole batch', async () => {
      fetchMock.mockResolvedValueOnce(ok({ results: 'nope' }));
      expect(await client.checkBulk({ principalId: 'p1' }, [
        { permission: 'view', resourceType: 'page', resourceId: 'a' },
        { permission: 'view', resourceType: 'page', resourceId: 'b' },
      ])).toEqual([false, false]);
    });

    it('checkBulk: a wrong-length `results` denies the whole batch', async () => {
      fetchMock.mockResolvedValueOnce(ok({ results: [true] }));
      expect(await client.checkBulk({ principalId: 'p1' }, [
        { permission: 'view', resourceType: 'page', resourceId: 'a' },
        { permission: 'view', resourceType: 'page', resourceId: 'b' },
      ])).toEqual([false, false]);
    });

    it('checkBulk: truthy non-boolean elements are coerced to deny (never allow)', async () => {
      fetchMock.mockResolvedValueOnce(ok({ results: [1, 'x'] }));
      expect(await client.checkBulk({ principalId: 'p1' }, [
        { permission: 'view', resourceType: 'page', resourceId: 'a' },
        { permission: 'view', resourceType: 'page', resourceId: 'b' },
      ])).toEqual([false, false]);
    });

    it('filterResources: a string `ids` does not iterate per-character (empty)', async () => {
      fetchMock.mockResolvedValueOnce(ok({ ids: 'abc' }));
      expect(await client.filterResources({ principalId: 'p1' }, 'view', 'page', ['a', 'b'])).toEqual([]);
    });

    it('lookupResources: a non-array `ids` yields the empty set', async () => {
      fetchMock.mockResolvedValueOnce(ok({ ids: 5 }));
      expect(await client.lookupResources({ principalId: 'p1' }, 'view', 'page')).toEqual([]);
    });

    it('filterSubjects: a non-array `subjects` yields empty without throwing', async () => {
      fetchMock.mockResolvedValueOnce(ok({ subjects: 42 }));
      expect(await client.filterSubjects('view', 'page', 'pg1', ['u1', 'u2'])).toEqual([]);
    });
  });
});

/**
 * PLATFORM_AUTHZ_TIMEOUT_MS drives the AbortController that bounds every PEP→platform authz call. A bad
 * value must NEVER become 0/NaN — that fires the abort immediately, so every call aborts and this
 * fail-closed client denies ALL access (a self-inflicted deny-all outage). An empty string is the realistic
 * regression: IaC templating an unset var yields "". (#14)
 */
describe('sanitizeAuthzTimeoutMs (PLATFORM_AUTHZ_TIMEOUT_MS)', () => {
  it('falls back (never 0/NaN) on a missing/empty/non-numeric/negative/zero value', () => {
    expect(sanitizeAuthzTimeoutMs(undefined, 1500)).toBe(1500);
    expect(sanitizeAuthzTimeoutMs('', 1500)).toBe(1500); // Number('') = 0 → would abort-all; falls back
    expect(sanitizeAuthzTimeoutMs('abc', 1500)).toBe(1500); // Number('abc') = NaN → falls back
    expect(sanitizeAuthzTimeoutMs('-10', 1500)).toBe(1500);
    expect(sanitizeAuthzTimeoutMs('0', 1500)).toBe(1500); // 0 = "abort immediately"; never allowed
  });

  it('clamps to [250, 60000] and passes a sane value through', () => {
    expect(sanitizeAuthzTimeoutMs('1', 1500)).toBe(250); // too-tight typo cannot self-DoS authz
    expect(sanitizeAuthzTimeoutMs('600000', 1500)).toBe(60000); // too-loose typo cannot un-bound the call
    expect(sanitizeAuthzTimeoutMs('2000', 1500)).toBe(2000);
  });
});
