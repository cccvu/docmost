import { HttpAuthzClient } from './http-authz.client';

/**
 * CCC authorization CONTRACT test (part of the fork's compatibility suite).
 *
 * Distinct from http-authz.client.spec.ts: this file pins two transport-level
 * invariants the client OWES the wiki request path, derived from intended behavior —
 * NOT from what the current implementation happens to do. Both are currently
 * unimplemented, so these tests are expected to FAIL (fail-bug-exposing) until the
 * client is fixed. Do not weaken or skip them to go green.
 *
 *   (#10) A call to the platform must abort after a bounded request timeout so a
 *         slow/hung platform cannot hang the wiki request; it must resolve fail-closed.
 *   (#15) filterResources / filterSubjects must chunk candidate arrays to the platform's
 *         1000-cap (the DTO enforces @ArrayMaxSize(1000)) and union the results — never
 *         send a single over-cap request the platform would 400 (a fail-closed DROP).
 */
describe('HttpAuthzClient — transport contract (intended behavior)', () => {
  let client: HttpAuthzClient;
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.PLATFORM_AUTHZ_URL = 'http://platform.test';
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'sekret';
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    fetchMock.mockReset();
    client = new HttpAuthzClient();
  });

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  // A DOMException-like abort error, as Node's fetch throws when its AbortSignal fires.
  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

  describe('(#10) bounded request timeout — a hung platform must not hang the wiki request', () => {
    // INVARIANT (#10): the client must set a bounded per-request timeout and, on a slow/hung
    // platform, abort and resolve fail-closed (false) well within that bound. This mock never
    // settles on its own within the test's lifetime; it only settles if the client aborts it via
    // AbortSignal (the intended fix) OR if the client resolves on its own internal timeout. If the
    // client sets NO timeout (current behavior), client.check() never resolves — so the bounded
    // race below makes THIS test FAIL fast (at ~BOUND_MS) rather than hang the whole suite.
    it('aborts a hung platform call within a bounded time and fails closed', async () => {
      const BOUND_MS = 2000;

      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) return reject(abortError());
            signal.addEventListener('abort', () => reject(abortError()));
          }
          // Never resolves within the test window; unref'd so it can't keep Node alive.
          const t = setTimeout(() => resolve(ok({ allowed: true })), 60_000);
          (t as unknown as { unref?: () => void }).unref?.();
        });
      });

      const TIMED_OUT = Symbol('bound-exceeded');
      const boundTimer = new Promise<typeof TIMED_OUT>((r) => {
        const t = setTimeout(() => r(TIMED_OUT), BOUND_MS);
        (t as unknown as { unref?: () => void }).unref?.();
      });

      const result = await Promise.race([
        client.check({ principalId: 'p1' }, 'view', 'page', 'x'),
        boundTimer,
      ]);

      // The client must have returned a decision before the bound elapsed — not still be hanging.
      expect(result).not.toBe(TIMED_OUT);
      // Fail-closed: a timed-out / aborted platform call denies.
      expect(result).toBe(false);
    }, 4000); // per-test jest timeout > BOUND_MS so a no-timeout client fails fast, never hangs the suite.
  });

  describe('(#15) 1000-cap chunking — over-cap candidate arrays must be split, not dropped', () => {
    // INVARIANT (#15): the platform DTO enforces @ArrayMaxSize(1000) on filter-resources
    // candidateIds and filter-subjects candidates. The client MUST split >1000 candidates into
    // multiple <=1000 requests and union the allowed results. A single over-cap request is 400'd
    // by the platform, which the fail-closed client turns into an EMPTY result — silently dropping
    // authorized objects from lists/search. These mocks echo every candidate back as "allowed", so
    // a correct (chunking) client returns all 1500; the current single-request client is caught by
    // the per-request cap assertion.

    it('filterResources chunks 1500 candidate ids to <=1000 per request and unions the results', async () => {
      const candidateIds = Array.from({ length: 1500 }, (_, i) => `p${i}`);

      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        const sent = JSON.parse(init!.body as string).candidateIds as string[];
        return ok({ ids: sent }); // echo: every id asked about is allowed
      });

      const allowed = await client.filterResources(
        { principalId: 'p1' },
        'view',
        'page',
        candidateIds,
      );

      // Every issued request must respect the platform's 1000-cap.
      for (const [, init] of fetchMock.mock.calls) {
        const sent = JSON.parse((init as RequestInit).body as string).candidateIds as string[];
        expect(sent.length).toBeLessThanOrEqual(1000);
      }
      // 1500 candidates cannot fit in one capped request.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      // The union must cover every candidate — no fail-closed drop of over-cap ids.
      expect(new Set(allowed)).toEqual(new Set(candidateIds));
      expect(allowed).toHaveLength(1500);
    });

    it('filterSubjects chunks 1500 candidates to <=1000 per request and unions the results', async () => {
      const candidateUserIds = Array.from({ length: 1500 }, (_, i) => `u${i}`);

      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        const sent = JSON.parse(init!.body as string).candidates as Array<{ externalId: string }>;
        // echo: every candidate subject passes
        return ok({ subjects: sent.map((c) => ({ provider: 'docmost', externalId: c.externalId })) });
      });

      const allowed = await client.filterSubjects('view', 'page', 'pg1', candidateUserIds);

      // Every issued request must respect the platform's 1000-cap.
      for (const [, init] of fetchMock.mock.calls) {
        const sent = JSON.parse((init as RequestInit).body as string).candidates as unknown[];
        expect(sent.length).toBeLessThanOrEqual(1000);
      }
      // 1500 candidates cannot fit in one capped request.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      // The union must recover every passing user id — no fail-closed drop of over-cap candidates.
      expect(new Set(allowed)).toEqual(new Set(candidateUserIds));
      expect(allowed).toHaveLength(1500);
    });
  });
});
