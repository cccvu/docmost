import { HttpAuthzClient } from '../http-authz.client';
import type { SearchPdpClient } from './pdp-search.service';

/**
 * CCC authorization integration test — `HttpAuthzClient.tryFilterResources` (#696), the decision search gates
 * through. Unlike `filterResources` (fail-closed: failure = "none allowed"), it reports failure as `null`, so search
 * can answer 503 instead of "no results" during an authorization outage. A failure in ANY chunk is a failure: a
 * partial union would silently drop authorized pages.
 */
describe('HttpAuthzClient.tryFilterResources (#696)', () => {
  const fetchMock = jest.fn();
  let client: HttpAuthzClient;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const subject = { provider: 'docmost', externalId: 'u1' };

  beforeEach(() => {
    process.env.PLATFORM_AUTHZ_URL = 'http://platform.test';
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'sekret';
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    fetchMock.mockReset();
    client = new HttpAuthzClient();
    jest.spyOn((client as any).logger, 'error').mockImplementation();
  });

  it('satisfies the search gate port', () => {
    const port: SearchPdpClient = client;
    expect(typeof port.tryFilterResources).toBe('function');
  });

  it('answers the allowed ids, with the same request as filterResources', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ids: ['p1'] }));
    expect(await client.tryFilterResources(subject, 'view', 'page', ['p1', 'p2'])).toEqual(['p1']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://platform.test/authz/filter-resources');
    expect(JSON.parse(init.body)).toEqual({ subject, permission: 'view', resourceType: 'page', candidateIds: ['p1', 'p2'] });
  });

  it('an empty candidate list is [] without a call', async () => {
    expect(await client.tryFilterResources(subject, 'view', 'page', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a real "none allowed" is [] (not a failure)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ids: [] }));
    expect(await client.tryFilterResources(subject, 'view', 'page', ['p1'])).toEqual([]);
  });

  it.each([
    ['a transport error', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['a non-2xx', () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })],
    ['a non-array ids', () => Promise.resolve(ok({ ids: 'p1' }))],
    ['a non-string element', () => Promise.resolve(ok({ ids: ['p1', 7] }))],
    ['no envelope', () => Promise.resolve(ok(null))],
  ])('%s → null (never an empty "deny")', async (_n, answer) => {
    fetchMock.mockImplementationOnce(answer);
    expect(await client.tryFilterResources(subject, 'view', 'page', ['p1'])).toBeNull();
  });

  it('chunks to the 1000-cap and unions; a failure in ANY chunk is null, never the partial union', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `p${i}`);
    fetchMock.mockResolvedValueOnce(ok({ ids: ['p0'] })).mockResolvedValueOnce(ok({ ids: ['p1499'] }));
    expect(await client.tryFilterResources(subject, 'view', 'page', ids)).toEqual(['p0', 'p1499']);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).candidateIds.length)).toEqual([1000, 500]);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(ok({ ids: ['p0'] })).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await client.tryFilterResources(subject, 'view', 'page', ids)).toBeNull();
  });
});
