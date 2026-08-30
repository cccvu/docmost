import * as http from 'http';
import type { AddressInfo } from 'net';
import { PlatformAuthzClient } from '../platform-authz.client';
import { PlatformAuditClient } from '../audit/platform-audit.client';

/**
 * PEP↔PDP CONSUMER contract (fork / Docmost side of the seam) — GitHub Task #16, contract #13.
 *
 * The fork's enforcement funnels EVERY fine-grained authorization decision through
 * `PlatformAuthzClient` (the PEP calling the platform's Authorization API) and forwards domain
 * audit through `PlatformAuditClient`. If the wire shape this consumer emits silently drifts from
 * what the platform (producer) expects, the platform will answer "deny"/"no match" to malformed
 * requests and — because the client is FAIL-CLOSED — the fork keeps running while quietly enforcing
 * NOTHING correctly (or, worse, mis-parsing a response into a grant). This spec pins the consumer
 * half so any such drift breaks a test instead of security.
 *
 * INTENDED behavior asserted (from platform-authz.client.ts / platform-audit.client.ts doc-comments
 * + docs/architecture.md "the platform owns policy; this is only a client; FAIL-CLOSED"):
 *   (a) each method emits the exact canonical request: POST, correct path, x-authz-service-secret
 *       header, and an exact body shape (toEqual — no extra/renamed/missing fields);
 *   (b) given the canonical response, the client returns the correctly parsed result;
 *   (c) the client FAILS CLOSED (false / empty) on any non-200 or transport error;
 *   (d) the audit client POSTs {events:[...]} to /audit/ingest with the secret and is
 *       fire-and-forget — it never throws, even on failure.
 *
 * Approach: drive the REAL client classes against a real loopback http server on an ephemeral port
 * (no Docker, no live stack) so the assertions are made against the bytes actually put on the wire
 * by the real `fetch` path, not a hand-rolled fetch stub.
 *
 * source of truth: contract/pep-pdp.contract.json
 * The canonical request/response shapes are embedded INLINE below on purpose: the fork is a git
 * submodule, so reading the platform-side fixture file at runtime is fragile across the boundary.
 * These constants MUST stay in lock-step with contract/pep-pdp.contract.json — that file is the
 * shared source of truth for both halves of this seam.
 */

const SERVICE_SECRET = 'test-service-secret';

/** Canonical fixtures — mirror of contract/pep-pdp.contract.json (see source-of-truth note above). */
const CONTRACT = {
  check: {
    path: '/authz/check',
    request: {
      subject: { provider: 'docmost', externalId: 'u-alice' },
      permission: 'view',
      resourceType: 'space',
      resourceId: 'sp-eng',
    },
    response: { allowed: true },
    expected: true,
  },
  checkBulk: {
    path: '/authz/check-bulk',
    request: {
      subject: { provider: 'docmost', externalId: 'u-alice' },
      checks: [
        { permission: 'view', resourceType: 'space', resourceId: 'sp-eng' },
        { permission: 'edit', resourceType: 'space', resourceId: 'sp-eng' },
        { permission: 'delete', resourceType: 'space', resourceId: 'sp-eng' },
      ],
    },
    response: { results: [true, false, true] },
    expected: [true, false, true],
  },
  filterResources: {
    path: '/authz/filter-resources',
    request: {
      subject: { provider: 'docmost', externalId: 'u-alice' },
      permission: 'view',
      resourceType: 'page',
      candidateIds: ['pg-1', 'pg-2', 'pg-3'],
    },
    response: { ids: ['pg-1', 'pg-3'] },
    expected: ['pg-1', 'pg-3'],
  },
  lookupResources: {
    path: '/authz/lookup-resources',
    request: {
      subject: { provider: 'docmost', externalId: 'u-alice' },
      permission: 'view',
      resourceType: 'page',
    },
    response: { ids: ['pg-7', 'pg-9'] },
    expected: ['pg-7', 'pg-9'],
  },
  filterSubjects: {
    path: '/authz/filter-subjects',
    // NOTE: subject-SIDE filter — the body carries `candidates` (docmost-wrapped user ids), NOT a
    // `subject`. The client wraps raw candidate user ids into {provider:'docmost', externalId}.
    request: {
      permission: 'view',
      resourceType: 'page',
      resourceId: 'pg-1',
      candidates: [
        { provider: 'docmost', externalId: 'u1' },
        { provider: 'docmost', externalId: 'u2' },
        { provider: 'docmost', externalId: 'u3' },
      ],
    },
    // input user ids the client is called with (pre-wrapping):
    inputUserIds: ['u1', 'u2', 'u3'],
    response: { subjects: [
      { provider: 'docmost', externalId: 'u1' },
      { provider: 'docmost', externalId: 'u3' },
    ] },
    expected: ['u1', 'u3'],
  },
  auditIngest: {
    path: '/audit/ingest',
    event: { event: 'page.restricted', resourceType: 'page', resourceId: 'pg1', workspaceId: 'w1' },
  },
} as const;

interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: any;
}

// Programmable next response for the loopback server: a 2xx/non-2xx JSON reply, or `{ destroy: true }`
// which drops the socket mid-flight to simulate a transport error (undici → "fetch failed").
type NextResponse = { status: number; body: unknown } | { destroy: true };

describe('PEP↔PDP consumer contract — real clients over a loopback PDP (#13)', () => {
  let server: http.Server;
  let baseUrl: string;
  let captured: CapturedRequest | undefined;
  let nextResponse: NextResponse;

  let authz: PlatformAuthzClient;
  let audit: PlatformAuditClient;

  const savedEnv = {
    url: process.env.PLATFORM_AUTHZ_URL,
    secret: process.env.PLATFORM_AUTHZ_SERVICE_SECRET,
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        captured = {
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: raw ? JSON.parse(raw) : undefined,
        };
        if ('destroy' in nextResponse) {
          req.socket.destroy();
          return;
        }
        res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(nextResponse.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    // The clients read these env vars at construction time (field initializers), so set BEFORE `new`.
    process.env.PLATFORM_AUTHZ_URL = baseUrl;
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SERVICE_SECRET;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.PLATFORM_AUTHZ_URL = savedEnv.url;
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = savedEnv.secret;
  });

  beforeEach(() => {
    captured = undefined;
    nextResponse = { status: 200, body: {} };
    authz = new PlatformAuthzClient();
    audit = new PlatformAuditClient();
  });

  /** Assert the common wire envelope every PEP→PDP call must carry (invariant: method+path+secret). */
  function expectEnvelope(path: string) {
    expect(captured).toBeDefined();
    expect(captured!.method).toBe('POST');
    expect(captured!.path).toBe(path);
    expect(captured!.headers['x-authz-service-secret']).toBe(SERVICE_SECRET);
    expect(String(captured!.headers['content-type'])).toContain('application/json');
  }

  // ---------------------------------------------------------------------------------------------
  // check()
  // ---------------------------------------------------------------------------------------------
  describe('check()', () => {
    const F = CONTRACT.check;

    it('POSTs the canonical /authz/check request and returns the parsed allowed decision', async () => {
      // Invariant (a)+(b): exact request envelope/body, and the response { allowed } is parsed.
      nextResponse = { status: 200, body: F.response };
      const out = await authz.check(F.request.subject, F.request.permission, F.request.resourceType, F.request.resourceId);
      expect(out).toBe(F.expected);
      expectEnvelope(F.path);
      expect(captured!.body).toEqual(F.request);
    });

    it('parses { allowed:false } as a deny (only strict true is a grant)', async () => {
      // Invariant (b): the client must not coerce a falsey/absent decision into a grant.
      nextResponse = { status: 200, body: { allowed: false } };
      expect(await authz.check(F.request.subject, 'view', 'space', 'sp-eng')).toBe(false);
    });

    it('FAILS CLOSED (denies) on a non-200 from the PDP', async () => {
      // Invariant (c): a platform outage/5xx must never silently grant.
      nextResponse = { status: 503, body: { error: 'unavailable' } };
      expect(await authz.check(F.request.subject, 'view', 'space', 'sp-eng')).toBe(false);
    });

    it('FAILS CLOSED (denies) on a transport error', async () => {
      // Invariant (c): a dropped connection must resolve to deny, not throw or grant.
      nextResponse = { destroy: true };
      expect(await authz.check(F.request.subject, 'view', 'space', 'sp-eng')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // checkBulk()
  // ---------------------------------------------------------------------------------------------
  describe('checkBulk()', () => {
    const F = CONTRACT.checkBulk;

    it('POSTs the canonical /authz/check-bulk request and returns the parsed results array', async () => {
      // Invariant (a)+(b): body carries { subject, checks[] }; response { results } is returned in order.
      nextResponse = { status: 200, body: F.response };
      const out = await authz.checkBulk(F.request.subject, [...F.request.checks]);
      expect(out).toEqual(F.expected);
      expectEnvelope(F.path);
      expect(captured!.body).toEqual(F.request);
    });

    it('short-circuits to [] without any PDP call for an empty check set', async () => {
      // Invariant: no wasted round trip; nothing hits the wire.
      const out = await authz.checkBulk(F.request.subject, []);
      expect(out).toEqual([]);
      expect(captured).toBeUndefined();
    });

    it('FAILS CLOSED to an all-false array of the SAME length on a non-200', async () => {
      // Invariant (c): length must be preserved so callers index results positionally, all denied.
      nextResponse = { status: 500, body: {} };
      expect(await authz.checkBulk(F.request.subject, [...F.request.checks])).toEqual([false, false, false]);
    });

    it('FAILS CLOSED to an all-false array of the SAME length on a transport error', async () => {
      // Invariant (c): same as above for a dropped connection.
      nextResponse = { destroy: true };
      expect(await authz.checkBulk(F.request.subject, [...F.request.checks])).toEqual([false, false, false]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // filterResources()
  // ---------------------------------------------------------------------------------------------
  describe('filterResources()', () => {
    const F = CONTRACT.filterResources;

    it('POSTs the canonical /authz/filter-resources request and returns the authorized id subset', async () => {
      // Invariant (a)+(b): body { subject, permission, resourceType, candidateIds }; response { ids }.
      nextResponse = { status: 200, body: F.response };
      const out = await authz.filterResources(F.request.subject, F.request.permission, F.request.resourceType, [...F.request.candidateIds]);
      expect(out).toEqual(F.expected);
      expectEnvelope(F.path);
      expect(captured!.body).toEqual(F.request);
    });

    it('short-circuits to [] without any PDP call for an empty candidate set', async () => {
      const out = await authz.filterResources(F.request.subject, 'view', 'page', []);
      expect(out).toEqual([]);
      expect(captured).toBeUndefined();
    });

    it('FAILS CLOSED to [] (reveal nothing) on a non-200', async () => {
      // Invariant (c): a filter path that fails must expose zero objects, never the raw candidates.
      nextResponse = { status: 502, body: {} };
      expect(await authz.filterResources(F.request.subject, 'view', 'page', [...F.request.candidateIds])).toEqual([]);
    });

    it('FAILS CLOSED to [] on a transport error', async () => {
      nextResponse = { destroy: true };
      expect(await authz.filterResources(F.request.subject, 'view', 'page', [...F.request.candidateIds])).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // lookupResources()
  // ---------------------------------------------------------------------------------------------
  describe('lookupResources()', () => {
    const F = CONTRACT.lookupResources;

    it('POSTs the canonical /authz/lookup-resources request and returns the parsed id list', async () => {
      // Invariant (a)+(b): body { subject, permission, resourceType }; response { ids }.
      nextResponse = { status: 200, body: F.response };
      const out = await authz.lookupResources(F.request.subject, F.request.permission, F.request.resourceType);
      expect(out).toEqual(F.expected);
      expectEnvelope(F.path);
      expect(captured!.body).toEqual(F.request);
    });

    it('FAILS CLOSED to [] on a non-200', async () => {
      // Invariant (c): reverse-index lookup that fails yields no objects.
      nextResponse = { status: 500, body: {} };
      expect(await authz.lookupResources(F.request.subject, 'view', 'page')).toEqual([]);
    });

    it('FAILS CLOSED to [] on a transport error', async () => {
      nextResponse = { destroy: true };
      expect(await authz.lookupResources(F.request.subject, 'view', 'page')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // filterSubjects()  (subject-side reverse filter)
  // ---------------------------------------------------------------------------------------------
  describe('filterSubjects()', () => {
    const F = CONTRACT.filterSubjects;

    it('wraps candidate user ids into docmost subject refs and returns the passing externalIds', async () => {
      // Invariant (a)+(b): body carries `candidates` (NOT `subject`); response { subjects } → externalIds.
      nextResponse = { status: 200, body: F.response };
      const out = await authz.filterSubjects(F.request.permission, F.request.resourceType, F.request.resourceId, [...F.inputUserIds]);
      expect(out).toEqual(F.expected);
      expectEnvelope(F.path);
      expect(captured!.body).toEqual(F.request);
      // Belt-and-braces: the subject-side call must NOT carry a `subject` envelope field.
      expect(captured!.body.subject).toBeUndefined();
    });

    it('drops subjects with no externalId when parsing the response', async () => {
      // Invariant (b): only real, echoed docmost user ids come back (filter of falsy externalIds).
      nextResponse = { status: 200, body: { subjects: [
        { provider: 'docmost', externalId: 'u1' },
        { provider: 'docmost' },            // missing externalId → dropped
        { provider: 'docmost', externalId: 'u3' },
      ] } };
      expect(await authz.filterSubjects('view', 'page', 'pg-1', ['u1', 'u2', 'u3'])).toEqual(['u1', 'u3']);
    });

    it('short-circuits to [] without any PDP call for an empty candidate set', async () => {
      const out = await authz.filterSubjects('view', 'page', 'pg-1', []);
      expect(out).toEqual([]);
      expect(captured).toBeUndefined();
    });

    it('FAILS CLOSED to [] (no recipients) on a non-200', async () => {
      // Invariant (c): a failed recipient filter must expose nobody, not the raw candidate list.
      nextResponse = { status: 503, body: {} };
      expect(await authz.filterSubjects('view', 'page', 'pg-1', ['u1', 'u2', 'u3'])).toEqual([]);
    });

    it('FAILS CLOSED to [] on a transport error', async () => {
      nextResponse = { destroy: true };
      expect(await authz.filterSubjects('view', 'page', 'pg-1', ['u1', 'u2', 'u3'])).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // audit forwarder — fire-and-forget contract
  // ---------------------------------------------------------------------------------------------
  describe('PlatformAuditClient.forward()', () => {
    const F = CONTRACT.auditIngest;

    it('POSTs { events:[...] } to /audit/ingest with the service secret', async () => {
      // Invariant (d): the audit envelope wraps events under `events` and carries the shared secret.
      nextResponse = { status: 202, body: {} };
      await audit.forward([{ ...F.event }]);
      expectEnvelope(F.path);
      expect(captured!.body).toEqual({ events: [F.event] });
    });

    it('skips the call entirely for an empty batch', async () => {
      await audit.forward([]);
      expect(captured).toBeUndefined();
    });

    it('is fire-and-forget: NEVER throws on a non-200 (event dropped, request unblocked)', async () => {
      // Invariant (d): audit must never break a user request — opposite posture to the authz client.
      nextResponse = { status: 503, body: {} };
      await expect(audit.forward([{ ...F.event }])).resolves.toBeUndefined();
    });

    it('is fire-and-forget: NEVER throws on a transport error', async () => {
      nextResponse = { destroy: true };
      await expect(audit.forward([{ ...F.event }])).resolves.toBeUndefined();
    });
  });
});
