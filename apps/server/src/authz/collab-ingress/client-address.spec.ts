import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { addressKey, collabClientKey, forwardedEntries, resolveClientIp, type ClientKey, type EdgeTrust } from './client-address';

/**
 * #810: the collab client address (client-address.ts), a port of the platform's trusted-proxy walk
 * (services/platform/src/boot/trust-proxy.ts) plus the fork's keying rules.
 *
 * trust-proxy-vectors.json is byte-identical to the platform's services/platform/test/fixtures copy (the super repo's
 * trust-proxy-vectors.spec.ts asserts it under PLATFORM_REQUIRE_FORK=1), so both walks answer the same table. A vector is
 * what a server RECEIVES: `peer` (hop 0, the ALB in production), `xff` after the ALB appended (null: no header; an
 * array: several header lines), and `nodeEnv`, from which the platform's endpoint derives `xffTrusted`
 * (`buildTrustProxy(...) !== false`, i.e. production only).
 */
interface Vector {
  name: string;
  appliesTo: Array<'platform' | 'fork'>;
  nodeEnv: string;
  trustedProxies: string[];
  peer: string;
  xff: string | string[] | null;
  expect?: string;
  expectRefused?: true;
}
const vectors = (JSON.parse(readFileSync(join(__dirname, 'trust-proxy-vectors.json'), 'utf8')) as Vector[]).filter((v) => v.appliesTo.includes('fork'));
const PROXY = '107.22.62.237';

/** The trust the platform's GET /authz/edge-trust serves for a vector's configuration. */
const trustOf = (v: Vector): EdgeTrust => ({ trustedProxies: v.trustedProxies, xffTrusted: v.nodeEnv === 'production' });

/** The request a vector describes, as Node would hand it over (headersDistinct keeps lines apart; headers joins them). */
const requestOf = (v: Vector, extra: Record<string, string> = {}) => {
  const lines = v.xff === null ? [] : Array.isArray(v.xff) ? v.xff : [v.xff];
  return {
    headers: { ...extra, ...(lines.length ? { 'x-forwarded-for': lines.join(', ') } : {}) },
    headersDistinct: { ...Object.fromEntries(Object.entries(extra).map(([k, val]) => [k, [val]])), ...(lines.length ? { 'x-forwarded-for': lines } : {}) },
    socket: { remoteAddress: v.peer },
  };
};

/** What a vector expects, in ClientKey terms. */
const outcome = (k: ClientKey): string => (k.status === 'keyed' ? k.key : `refused:${k.why}`);
const expected = (v: Vector): string => (v.expectRefused ? 'refused:xff_lines' : v.expect!);

describe('#810 the shared trust-proxy vectors (fork walk)', () => {
  it('the table binds the fork and is not vacuous (forged rows, Stage B, non-production, two-line refusals)', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
    expect(vectors.filter((v) => /forg/i.test(v.name)).length).toBeGreaterThanOrEqual(4);
    expect(vectors.filter((v) => v.trustedProxies.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(vectors.filter((v) => v.nodeEnv !== 'production').length).toBeGreaterThanOrEqual(1);
    expect(vectors.filter((v) => v.expectRefused).length).toBeGreaterThanOrEqual(2);
    for (const v of vectors) expect(v.expectRefused ? v.expect : typeof v.expect).toBe(v.expectRefused ? undefined : 'string');
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(outcome(collabClientKey(requestOf(v), trustOf(v)))).toBe(expected(v));
  });

  it('a forged X-Real-IP never moves the key (it is never read)', () => {
    for (const v of vectors) {
      expect(outcome(collabClientKey(requestOf(v, { 'x-real-ip': '6.6.6.6', 'cf-connecting-ip': '6.6.6.7' }), trustOf(v)))).toBe(expected(v));
    }
  });

  it('hop: 1 for a direct client, 2 through the proxy, 0 for the peer itself', () => {
    const at = (xff: string | null, nodeEnv = 'production') => {
      const k = collabClientKey(requestOf({ name: '', appliesTo: ['fork'], nodeEnv, trustedProxies: [PROXY], peer: '172.31.20.10', xff }), {
        trustedProxies: [PROXY],
        xffTrusted: nodeEnv === 'production',
      });
      return k.status === 'keyed' ? k.hop : -1;
    };
    expect(at('198.51.100.7')).toBe(1);
    expect(at(`198.51.100.7, ${PROXY}`)).toBe(2);
    expect(at(null)).toBe(0);
    expect(at(`198.51.100.7, ${PROXY}`, 'development')).toBe(0);
  });

  describe('anti-vacuity: the table rejects the walks it exists to rule out', () => {
    /** How many fork vectors a mutant walk gets wrong (it must be at least one). */
    const failures = (mutant: (v: Vector) => string) => vectors.filter((v) => mutant(v) !== expected(v)).map((v) => v.name);
    const entries = (v: Vector) => (typeof v.xff === 'string' ? forwardedEntries(v.xff) : Array.isArray(v.xff) ? forwardedEntries(v.xff.join(', ')) : []);
    const keyOf = (a: string) => addressKey(a)?.key ?? 'refused:not_ip';

    it('trusting every hop (Fastify trustProxy:true, the leftmost entry)', () => {
      const leftmost = (v: Vector) => (v.expectRefused ? expected(v) : keyOf(resolveClientIp([v.peer, ...entries(v)], () => true).address));
      expect(failures(leftmost)).toEqual(expect.arrayContaining(['proxied with a forged X-Forwarded-For prefix', 'direct with a forged prefix']));
    });

    it('keying on the socket peer', () => {
      expect(failures((v) => (v.expectRefused ? expected(v) : keyOf(v.peer))).length).toBeGreaterThanOrEqual(10);
    });

    it('a hop count of 2 instead of the address predicate', () => {
      const hops2 = (v: Vector) =>
        v.expectRefused ? expected(v) : keyOf(resolveClientIp([v.peer, ...entries(v)], v.nodeEnv === 'production' ? (_a, hop) => hop < 2 : false).address);
      expect(failures(hops2)).toEqual(expect.arrayContaining(['direct with a forged prefix']));
    });

    it('joining two X-Forwarded-For lines instead of refusing them', () => {
      const joined = (v: Vector) => outcome(collabClientKey({ ...requestOf(v), headersDistinct: undefined, headers: { 'x-forwarded-for': (v.xff as string[] | string | null)?.toString() } } as never, trustOf(v)));
      expect(failures(joined)).toEqual(vectors.filter((v) => v.expectRefused).map((v) => v.name));
    });
  });
});

describe('#810 forwardedEntries: one line, as the `forwarded` package parses it', () => {
  it('nearest hop first, spaces trimmed, empty entries dropped, interior text kept', () => {
    expect(forwardedEntries('a, b,c')).toEqual(['c', 'b', 'a']);
    expect(forwardedEntries(' a ,, b ,')).toEqual(['b', 'a']);
    expect(forwardedEntries('')).toEqual([]);
    expect(forwardedEntries('a b, c')).toEqual(['c', 'a b']);
  });
});

describe('#810 addressKey: an address as a bucket key', () => {
  it('IPv4 as itself; ::ffff:-mapped (dotted or hex) as its IPv4 form; brackets stripped', () => {
    expect(addressKey('198.51.100.7')).toEqual({ key: '198.51.100.7', kind: 'ipv4' });
    expect(addressKey('::ffff:198.51.100.7')).toEqual({ key: '198.51.100.7', kind: 'ipv4' });
    expect(addressKey('::FFFF:c633:6407')).toEqual({ key: '198.51.100.7', kind: 'ipv4' });
    expect(addressKey('[::ffff:198.51.100.7]')).toEqual({ key: '198.51.100.7', kind: 'ipv4' });
  });

  it('IPv6 by its /64: one /64 is one key, another /64 another', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toEqual({ key: '2001:db8:1:2::/64', kind: 'ipv6' });
    expect(addressKey('[2001:db8:1:2::9]')).toEqual({ key: '2001:db8:1:2::/64', kind: 'ipv6' });
    expect(addressKey('2001:DB8:1:2:ffff::1')).toEqual({ key: '2001:db8:1:2::/64', kind: 'ipv6' });
    expect(addressKey('2001:db8:1:3::1')!.key).not.toBe(addressKey('2001:db8:1:2::1')!.key);
    expect(addressKey('2001:db8::')).toEqual({ key: '2001:db8:0:0::/64', kind: 'ipv6' });
    expect(addressKey('::1')).toEqual({ key: '0:0:0:0::/64', kind: 'ipv6' });
    expect(addressKey('64:ff9b::198.51.100.7')).toEqual({ key: '64:ff9b:0:0::/64', kind: 'ipv6' });
  });

  it('anything that is not an IP is refused, never guessed: a port, a zone id, a hostname, junk, empty', () => {
    for (const bad of ['198.51.100.7:443', '[2001:db8::1]:443', 'fe80::1%eth0', 'example.com', 'unknown', '', '1.2.3', '::ffff:1.2.3.4:5', '1::2::3']) {
      expect(addressKey(bad)).toBeNull();
    }
  });
});

describe('#810 a REAL IncomingMessage: two X-Forwarded-For lines reach headersDistinct apart', () => {
  /** Send `head` raw to a real http server; resolve the IncomingMessage Node parsed. */
  const received = (head: string) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const server = createServer((req, res) => {
        res.end();
        server.close();
        resolve(req);
      });
      server.listen(0, '127.0.0.1', () => {
        const sock = connect((server.address() as AddressInfo).port, '127.0.0.1', () => sock.end(head));
        sock.on('error', reject);
      });
    });
  const trust: EdgeTrust = { trustedProxies: [PROXY], xffTrusted: true };

  it('two lines are refused (Node would have joined them into a trusted-looking chain); one line is keyed', async () => {
    const two = await received(`GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 9.9.9.9\r\nX-Forwarded-For: 198.51.100.7, ${PROXY}\r\n\r\n`);
    expect(two.headers['x-forwarded-for']).toBe(`9.9.9.9, 198.51.100.7, ${PROXY}`); // what a reader of `headers` would see
    expect(collabClientKey(two, trust)).toEqual({ status: 'refused', why: 'xff_lines' });
    const one = await received(`GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 9.9.9.9, 198.51.100.7, ${PROXY}\r\n\r\n`);
    expect(collabClientKey(one, trust)).toEqual({ status: 'keyed', key: '198.51.100.7', hop: 2, kind: 'ipv4' });
  });
});
