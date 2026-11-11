/**
 * CCC collab integration — NOT upstream Docmost code (#810, ADR 0036).
 *
 * The client address an upgrade comes from, worked out the way the platform works out `request.ip`
 * (services/platform/src/boot/trust-proxy.ts, #288): an ADDRESS predicate over the chain
 * `[socket peer, ...X-Forwarded-For reversed]`, never a hop count and never a header a client can set alone.
 *
 * - Hop 0, the socket peer, is trusted: the task's security group admits docmost's port only from the ALB.
 * - Beyond it, only the exact literals in the platform's trusted-proxy list are trusted (the nginx front door's EIP).
 * - The walk stops at the first untrusted hop, which is the client. The ALB APPENDS what it saw to X-Forwarded-For, so
 *   a client-written entry always sits to the left of the truthful one, later in the walk, and is never reached:
 *     via the proxy            [ALB, EIP, client, forged…]   → client
 *     direct to the ALB        [ALB, client, forged…]        → client
 *     direct, naming the proxy [ALB, client, EIP, forged…]   → client
 * - Outside production the platform trusts no forwarded header (`xffTrusted: false`), and neither does this: the
 *   client is the socket peer.
 *
 * The trust inputs come from the platform, the one owner of `PLATFORM_TRUSTED_PROXIES` (client-trust.ts). This file is
 * a line-for-line port of the platform's `buildTrustProxy` and `resolveClientIp`, because the fork cannot import
 * platform code (the AGPL boundary): trust-proxy-vectors.json, byte-identical to the platform's copy (a super-repo CI
 * check), pins both walks to the same answers.
 *
 * The fork's own rules on top of the walk, for a key that buckets sockets:
 * - Two X-Forwarded-For header LINES are refused. Node joins them with ", ", so a direct caller could plant an entry the
 *   ALB's append then sits beside rather than after (AWS does not document which line it appends to). Honest traffic
 *   never sends two: nginx writes one, browsers write none.
 * - The resolved address becomes a key: `::ffff:a.b.c.d` is a.b.c.d, `[x]` is x, an IPv6 address is keyed by its /64
 *   (one host holds a whole /64, so a /128 key would rotate freely), and anything that is not an IP (a port, a zone id,
 *   junk) is refused rather than guessed.
 *
 * Never upstream's `client-ip.utils` (v0.97, PR 2580), `proxy-addr`, Fastify's `request.ip` or `X-Real-IP`: they trust
 * private ranges, Cloudflare's header or the leftmost entry, any of which collapses every proxied user onto the proxy's
 * address or lets a direct caller pick its key (client-address.fitness.spec.ts). Nothing here logs an address.
 */
import type { IncomingMessage } from 'http';
import { isIP } from 'node:net';

/** What the platform serves at `GET /authz/edge-trust`. */
export interface EdgeTrust {
  /** The proxies trusted beyond hop 0: the platform's `cfg.gateway.trustedProxies`, bare IP literals. */
  trustedProxies: readonly string[];
  /** Whether X-Forwarded-For is walked at all: the platform's `buildTrustProxy(...) !== false` (production only). */
  xffTrusted: boolean;
}

export type TrustProxyPredicate = (address: string, hop: number) => boolean;

/** Port of the platform's `buildTrustProxy`, fed the platform's own answer instead of its `nodeEnv`. */
export function buildTrustProxy(trust: EdgeTrust): false | TrustProxyPredicate {
  if (!trust.xffTrusted) return false;
  const trusted = new Set(trust.trustedProxies);
  return (address: string, hop: number) => hop === 0 || trusted.has(address);
}

/**
 * Port of the platform's `resolveClientIp`: `chain[0]` is the socket peer, the rest X-Forwarded-For nearest hop first.
 * Returns the address and the hop it sits at (0 = the peer).
 */
export function resolveClientIp(chain: readonly string[], trust: false | TrustProxyPredicate): { address: string; hop: number } {
  if (trust === false) return { address: chain[0], hop: 0 };
  let i = 0;
  for (; i < chain.length - 1; i++) {
    if (!trust(chain[i], i)) break;
  }
  return { address: chain[i], hop: i };
}

/**
 * The X-Forwarded-For entries of ONE header line, nearest hop first: comma-separated, surrounding spaces trimmed,
 * empty entries dropped (the `forwarded` package's parse, which proxy-addr and Fastify use).
 */
export function forwardedEntries(line: string): string[] {
  return line
    .split(',')
    .map((s) => s.replace(/^ +| +$/g, ''))
    .filter((s) => s.length > 0)
    .reverse();
}

/** The upgrade request surface read here. */
export type ClientAddressRequest = Pick<IncomingMessage, 'headers'> & {
  headersDistinct?: Record<string, string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
};

export type ClientKey =
  | { status: 'keyed'; key: string; hop: number; kind: 'ipv4' | 'ipv6' }
  /** Not keyable: two X-Forwarded-For lines (`xff_lines`), or an address that is not an IP (`not_ip`). */
  | { status: 'refused'; why: 'xff_lines' | 'not_ip' };

/** The X-Forwarded-For header lines, as received (never joined). */
function forwardedLines(req: ClientAddressRequest): string[] {
  const distinct = req.headersDistinct?.['x-forwarded-for'];
  if (distinct) return distinct;
  const joined = req.headers['x-forwarded-for'];
  if (joined === undefined) return [];
  return Array.isArray(joined) ? joined : [joined];
}

/** The client key of an upgrade under `trust`: never throws, O(header length), logs nothing. */
export function collabClientKey(req: ClientAddressRequest, trust: EdgeTrust): ClientKey {
  const lines = forwardedLines(req);
  if (lines.length > 1) return { status: 'refused', why: 'xff_lines' };
  const chain = [req.socket?.remoteAddress ?? '', ...(lines.length === 1 ? forwardedEntries(lines[0]) : [])];
  const { address, hop } = resolveClientIp(chain, buildTrustProxy(trust));
  const key = addressKey(address);
  return key ? { status: 'keyed', key: key.key, hop, kind: key.kind } : { status: 'refused', why: 'not_ip' };
}

/** IPv4 as itself, `::ffff:`-mapped IPv4 as its IPv4 form, IPv6 as its /64; null for anything that is not an IP. */
export function addressKey(raw: string): { key: string; kind: 'ipv4' | 'ipv6' } | null {
  const bracketed = /^\[(.*)\]$/.exec(raw);
  const address = bracketed ? bracketed[1] : raw;
  if (address.includes('%')) return null; // a zone id names a local interface, never a remote client
  const version = isIP(address);
  if (version === 4) return { key: address, kind: 'ipv4' };
  if (version !== 6) return null;
  const hextets = expandIPv6(address);
  if (!hextets) return null;
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const [hi, lo] = [hextets[6], hextets[7]];
    return { key: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, kind: 'ipv4' };
  }
  return { key: `${hextets.slice(0, 4).map((h) => h.toString(16)).join(':')}::/64`, kind: 'ipv6' };
}

/** The eight hextets of an address `isIP` accepted as IPv6 (an embedded dotted IPv4 tail included), or null. */
function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (s: string) => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return all.length === 8 && all.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? all : null;
}
