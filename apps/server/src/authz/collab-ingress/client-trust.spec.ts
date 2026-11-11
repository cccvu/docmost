import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CollabClientTrust,
  parseEdgeTrust,
  platformEdgeTrustFetch,
  TRUST_REFRESH_MS,
  TRUST_RETRY_MAX_MS,
  TRUST_RETRY_MIN_MS,
  type EdgeTrustFetchResult,
} from './client-trust';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810: the fork's trusted-proxy list comes from the platform (`GET /authz/edge-trust`, client-trust.ts): unknown until
 * the platform answers (the share off, as before #810), active once it has, the last good answer kept through a failed
 * refresh, and never a guessed key.
 */
const PROXY = '107.22.62.237';
const GOOD = { trustedProxies: [PROXY], xffTrusted: true };
const request = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '172.31.20.10' } });

/** A trust with a scripted fetch and captured log lines. */
function harness(script: Array<EdgeTrustFetchResult | Error>) {
  const lines: string[] = [];
  const errors: string[] = [];
  const fetchTrust = jest.fn(async (): Promise<EdgeTrustFetchResult> => {
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const trust = new CollabClientTrust({
    fetchTrust,
    limitLog: new SocketLimitLog({ warn: (m) => lines.push(m) }),
    errorLog: { error: (m) => errors.push(m) },
  });
  return { trust, fetchTrust, lines, errors };
}

describe('#810 parseEdgeTrust: the platform answer, validated', () => {
  it('accepts the documented body (extra keys ignored) and freezes it', () => {
    expect(parseEdgeTrust(GOOD)).toEqual(GOOD);
    expect(parseEdgeTrust({ trustedProxies: [], xffTrusted: false })).toEqual({ trustedProxies: [], xffTrusted: false });
    expect(parseEdgeTrust({ ...GOOD, extra: 1 })).toEqual(GOOD);
    expect(parseEdgeTrust({ trustedProxies: ['2001:db8::1'], xffTrusted: true })).toEqual({ trustedProxies: ['2001:db8::1'], xffTrusted: true });
    expect(Object.isFrozen(parseEdgeTrust(GOOD)!.trustedProxies)).toBe(true);
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an array', [GOOD]],
    ['no xffTrusted', { trustedProxies: [PROXY] }],
    ['a string xffTrusted', { trustedProxies: [PROXY], xffTrusted: 'true' }],
    ['no list', { xffTrusted: true }],
    ['a string list', { trustedProxies: PROXY, xffTrusted: true }],
    ['a CIDR', { trustedProxies: ['107.22.62.0/24'], xffTrusted: true }],
    ['host:port', { trustedProxies: [`${PROXY}:443`], xffTrusted: true }],
    ['a hostname', { trustedProxies: ['proxy.example.com'], xffTrusted: true }],
    ['a URL', { trustedProxies: [`http://${PROXY}`], xffTrusted: true }],
    ['a number', { trustedProxies: [1], xffTrusted: true }],
    ['65 entries', { trustedProxies: Array.from({ length: 65 }, (_, i) => `10.0.0.${i}`), xffTrusted: true }],
  ])('refuses %s', (_name, body) => {
    expect(parseEdgeTrust(body)).toBeNull();
  });
});

describe('#810 CollabClientTrust: unknown until the platform answers, then active without a restart', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('platform down at boot: unknown (no key, the share off), retried with backoff, active once it answers', async () => {
    const { trust, fetchTrust, lines } = harness([{ reason: 'transport' }, { reason: 'transport' }, { reason: 'http_503' }, { body: GOOD }]);
    trust.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(trust.state).toBe('unknown');
    expect(trust.keyFor(request('198.51.100.7'))).toBeNull(); // no key is ever guessed
    expect(fetchTrust).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TRUST_RETRY_MIN_MS); // 1 s
    expect(fetchTrust).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2 * TRUST_RETRY_MIN_MS - 1); // then 2 s
    expect(fetchTrust).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchTrust).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(4 * TRUST_RETRY_MIN_MS); // then 4 s: it answers
    expect(fetchTrust).toHaveBeenCalledTimes(4);
    expect(trust.state).toBe('active');
    expect(trust.keyFor(request(`9.9.9.9, 198.51.100.7, ${PROXY}`))).toEqual({ status: 'keyed', key: '198.51.100.7', hop: 2, kind: 'ipv4' });
    // one line per change, never per attempt
    expect(lines).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"unknown","reason":"transport"}',
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"unknown","reason":"http_503"}',
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"active","proxies":1,"xff":"on"}',
    ]);
    trust.stop();
  });

  it('the backoff doubles to 30 s and stays there; a down platform logs one line', async () => {
    const { trust, fetchTrust, lines } = harness([{ reason: 'transport' }]);
    trust.start();
    await jest.advanceTimersByTimeAsync(0);
    for (const gap of [1, 2, 4, 8, 16, 30, 30, 30].map((s) => s * 1000)) {
      const before = fetchTrust.mock.calls.length;
      await jest.advanceTimersByTimeAsync(gap - 1);
      expect(fetchTrust).toHaveBeenCalledTimes(before);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetchTrust).toHaveBeenCalledTimes(before + 1);
    }
    expect([TRUST_RETRY_MIN_MS, TRUST_RETRY_MAX_MS, TRUST_REFRESH_MS]).toEqual([1_000, 30_000, 300_000]);
    expect(lines).toHaveLength(1);
    trust.stop();
  });

  it('an older platform (404) stays unknown: the share off, exactly as before #810', async () => {
    const { trust, lines } = harness([{ reason: 'http_404' }]);
    trust.start();
    await jest.advanceTimersByTimeAsync(10 * TRUST_RETRY_MAX_MS);
    expect(trust.state).toBe('unknown');
    expect(trust.keyFor(request('198.51.100.7'))).toBeNull();
    expect(lines).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"unknown","reason":"http_404"}']);
    trust.stop();
  });

  it('a malformed answer is rejected (unknown, an error line), and so is a body that is not JSON', async () => {
    const { trust, lines, errors } = harness([{ body: { trustedProxies: ['10.0.0.0/8'], xffTrusted: true } }, { body: undefined }, { body: GOOD }]);
    trust.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(trust.state).toBe('unknown');
    expect(errors).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","error":"malformed","state":"unknown"}']);
    await jest.advanceTimersByTimeAsync(TRUST_RETRY_MIN_MS);
    expect(trust.state).toBe('unknown');
    expect(errors).toHaveLength(1); // the same failure again: no new line
    await jest.advanceTimersByTimeAsync(2 * TRUST_RETRY_MIN_MS);
    expect(trust.state).toBe('active');
    expect(lines[lines.length - 1]).toBe('COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"active","proxies":1,"xff":"on"}');
    trust.stop();
  });

  it('active: refreshed every 5 min; a failed or malformed refresh keeps the last good list, then retries with backoff', async () => {
    const next = { trustedProxies: [PROXY, '107.22.62.238'], xffTrusted: true };
    const { trust, fetchTrust, lines } = harness([{ body: GOOD }, { reason: 'timeout' }, { body: 'junk' }, { body: next }]);
    trust.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(trust.trust).toEqual(GOOD);
    await jest.advanceTimersByTimeAsync(TRUST_REFRESH_MS - 1);
    expect(fetchTrust).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); // the refresh fails
    expect(fetchTrust).toHaveBeenCalledTimes(2);
    expect(trust.state).toBe('active');
    expect(trust.trust).toEqual(GOOD);
    await jest.advanceTimersByTimeAsync(TRUST_RETRY_MIN_MS); // retried at 1 s, malformed: still the last good list
    expect(trust.trust).toEqual(GOOD);
    await jest.advanceTimersByTimeAsync(2 * TRUST_RETRY_MIN_MS); // then 2 s: the new list
    expect(trust.trust).toEqual(next);
    expect(lines).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"active","proxies":1,"xff":"on"}',
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"active","reason":"timeout","proxies":1}',
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"active","reason":"malformed","proxies":1}',
      'COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"active","proxies":2,"xff":"on"}',
    ]);
    // the backoff reset on success: the next refresh is 5 min away
    const calls = fetchTrust.mock.calls.length;
    await jest.advanceTimersByTimeAsync(TRUST_REFRESH_MS - 1);
    expect(fetchTrust).toHaveBeenCalledTimes(calls);
    trust.stop();
  });

  it('a fetch that throws counts as a transport failure', async () => {
    const { trust, lines } = harness([new Error('boom')]);
    trust.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(trust.state).toBe('unknown');
    expect(lines).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"unknown","reason":"transport"}']);
    trust.stop();
  });

  it('stop() ends the loop, even with a fetch in flight; start() is idempotent', async () => {
    let release!: (r: EdgeTrustFetchResult) => void;
    const fetchTrust = jest.fn(() => new Promise<EdgeTrustFetchResult>((r) => (release = r)));
    const trust = new CollabClientTrust({ fetchTrust, limitLog: new SocketLimitLog({ warn: () => undefined }) });
    trust.start();
    trust.start();
    expect(fetchTrust).toHaveBeenCalledTimes(1);
    trust.stop();
    release({ reason: 'transport' });
    await jest.advanceTimersByTimeAsync(10 * TRUST_RETRY_MAX_MS);
    expect(fetchTrust).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('its timers are unref\'d (never hold the process open)', async () => {
    jest.useRealTimers();
    const { trust } = harness([{ reason: 'transport' }]);
    const spy = jest.spyOn(global, 'setTimeout');
    trust.start();
    await new Promise((r) => setImmediate(r));
    const timer = spy.mock.results.find((r) => r.type === 'return')?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    trust.stop();
    spy.mockRestore();
  });

  it('not configured (native mode, no PLATFORM_AUTHZ_URL): never fetches, logs unknown once', async () => {
    const lines: string[] = [];
    const trust = new CollabClientTrust({ fetchTrust: null, limitLog: new SocketLimitLog({ warn: (m) => lines.push(m) }) });
    trust.start();
    await jest.advanceTimersByTimeAsync(10 * TRUST_REFRESH_MS);
    expect(trust.state).toBe('unknown');
    expect(lines).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":"unknown","reason":"not_configured"}']);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('#810 platformEdgeTrustFetch: the existing authz channel (PLATFORM_AUTHZ_URL + the service secret)', () => {
  it('none outside remote mode, or without PLATFORM_AUTHZ_URL', () => {
    expect(platformEdgeTrustFetch('native', { PLATFORM_AUTHZ_URL: 'http://platform:4000' })).toBeNull();
    expect(platformEdgeTrustFetch(undefined, { PLATFORM_AUTHZ_URL: 'http://platform:4000' })).toBeNull();
    expect(platformEdgeTrustFetch('remote', {})).toBeNull();
    expect(platformEdgeTrustFetch('remote', { PLATFORM_AUTHZ_URL: 'http://platform:4000' })).toBeInstanceOf(Function);
  });

  describe('against a real HTTP server', () => {
    let server: Server;
    let base: string;
    let answer: (req: IncomingMessage, res: import('node:http').ServerResponse) => void;
    const seen: Array<{ method?: string; url?: string; secret?: string | string[] }> = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, secret: req.headers['x-authz-service-secret'] });
        answer(req, res);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    beforeEach(() => (seen.length = 0));
    const fetchFor = () => platformEdgeTrustFetch('remote', { PLATFORM_AUTHZ_URL: base, PLATFORM_AUTHZ_SERVICE_SECRET: 's3cret', PLATFORM_AUTHZ_TIMEOUT_MS: '250' })!;

    it('GET /authz/edge-trust with the service secret, no body: the parsed JSON', async () => {
      answer = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(GOOD));
      expect(await fetchFor()()).toEqual({ body: GOOD });
      expect(seen).toEqual([{ method: 'GET', url: '/authz/edge-trust', secret: 's3cret' }]);
    });

    it('a non-2xx is its status (404: an older platform)', async () => {
      answer = (_req, res) => res.writeHead(404).end('{"message":"Cannot GET"}');
      expect(await fetchFor()()).toEqual({ reason: 'http_404' });
      answer = (_req, res) => res.writeHead(401).end();
      expect(await fetchFor()()).toEqual({ reason: 'http_401' });
    });

    it('a 200 that is not JSON is a body nothing parses (malformed), never a transport error', async () => {
      answer = (_req, res) => res.writeHead(200).end('<html>');
      expect(await fetchFor()()).toEqual({ body: undefined });
    });

    it('a platform that never answers times out at PLATFORM_AUTHZ_TIMEOUT_MS', async () => {
      answer = () => undefined;
      const started = Date.now();
      expect(await fetchFor()()).toEqual({ reason: 'timeout' });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('nothing listening is a transport failure', async () => {
      const dead = platformEdgeTrustFetch('remote', { PLATFORM_AUTHZ_URL: 'http://127.0.0.1:1' })!;
      expect(await dead()).toEqual({ reason: 'transport' });
    });
  });
});
