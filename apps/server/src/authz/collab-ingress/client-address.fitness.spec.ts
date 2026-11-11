import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/**
 * CCC fitness test (#810, ADR 0036) — NOT upstream Docmost code.
 *
 * The collab per-address key comes from ONE place: client-address.ts's walk over the platform's trusted-proxy list. A
 * key from anywhere else is forgeable or collapses every proxied user onto the proxy's address:
 * - upstream's `client-ip.utils` (v0.97, PR 2580) trusts private ranges, link-local and Cloudflare's `CF-Connecting-IP`;
 * - `proxy-addr` / `forwarded` read the Node-JOINED header, so they cannot see two lines;
 * - Fastify's `request.ip` (main.ts sets `trustProxy: true`) is the leftmost, client-written X-Forwarded-For entry;
 * - `X-Real-IP` is honest only on the nginx path: the ALB passes a direct client's own value through.
 * So no collab-ingress source (nor the ws adapter, seam §226) imports such a resolver, reads `.ip`, or names one of those
 * headers, and only client-address.ts reads the socket peer or X-Forwarded-For. At the v0.97 merge, keep this resolver.
 */
const SRC = join(__dirname, '..', '..');
const INGRESS = 'authz/collab-ingress';
const ADAPTER = 'collaboration/adapter/collab-ws.adapter.ts';
const RESOLVER = `${INGRESS}/client-address.ts`;

const FORBIDDEN_IMPORT = /(^|\/)(client-ip(\.utils)?|proxy-addr|forwarded|request-ip)$|@fastify\/proxy-addr/;
const FORBIDDEN_HEADER = /^(x-real-ip|cf-connecting-ip|true-client-ip|x-client-ip|forwarded)$/i;

interface Finding {
  file: string;
  what: string;
}

/** Imports of a client-address resolver, `.ip` reads, and forbidden header names in `text`; plus the peer/XFF reads. */
function findings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      if (FORBIDDEN_IMPORT.test(n.moduleSpecifier.text)) out.push({ file, what: `import ${n.moduleSpecifier.text}` });
    }
    if (ts.isCallExpression(n) && n.expression.getText() === 'require' && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      if (FORBIDDEN_IMPORT.test(n.arguments[0].text)) out.push({ file, what: `require ${n.arguments[0].text}` });
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'ip') out.push({ file, what: '.ip' });
    if (ts.isStringLiteralLike(n) && FORBIDDEN_HEADER.test(n.text)) out.push({ file, what: `header ${n.text}` });
    if (file !== RESOLVER) {
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'remoteAddress') out.push({ file, what: '.remoteAddress' });
      if (ts.isStringLiteralLike(n) && n.text.toLowerCase() === 'x-forwarded-for') out.push({ file, what: 'header x-forwarded-for' });
    }
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return out;
}

const sources = (): string[] => [
  ...readdirSync(join(SRC, INGRESS))
    .filter((f) => /\.ts$/.test(f) && !/\.(spec|testkit|d)\.ts$/.test(f))
    .map((f) => `${INGRESS}/${f}`),
  ADAPTER,
];
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('#810 fitness: the collab client key comes only from client-address.ts', () => {
  it('the scan sees the resolver, the bounds, the slots and the adapter (anti-vacuity)', () => {
    const files = sources();
    for (const f of [RESOLVER, `${INGRESS}/preauth-slots.ts`, `${INGRESS}/socket-bounds.ts`, `${INGRESS}/client-trust.ts`, ADAPTER]) {
      expect(files).toContain(f);
    }
    // the resolver itself is where the peer and the header are read
    expect(read(RESOLVER)).toMatch(/req\.socket\?\.remoteAddress/);
    expect(read(RESOLVER)).toMatch(/'x-forwarded-for'/);
  });

  it('no collab-ingress source or the ws adapter keys on another resolver, request.ip, X-Real-IP, CF-Connecting-IP, or reads the peer/XFF itself', () => {
    expect(sources().flatMap((f) => findings(f, read(f)))).toEqual([]);
  });

  it('anti-vacuity: each forbidden shape is caught', () => {
    const f = `${INGRESS}/preauth-slots.ts`;
    const whats = (text: string) => findings(f, text).map((x) => x.what);
    expect(whats(`import { resolveClientIp } from '../../common/helpers/client-ip.utils';`)).toEqual(['import ../../common/helpers/client-ip.utils']);
    expect(whats(`import proxyaddr from 'proxy-addr';`)).toEqual(['import proxy-addr']);
    expect(whats(`import { forwarded } from '@fastify/proxy-addr';`)).toEqual(['import @fastify/proxy-addr']);
    expect(whats(`const fwd = require('forwarded');`)).toEqual(['require forwarded', 'header forwarded']);
    expect(whats(`const key = request.ip;`)).toEqual(['.ip']);
    expect(whats(`const key = req.headers['x-real-ip'];`)).toEqual(['header x-real-ip']);
    expect(whats(`const key = req.headers['CF-Connecting-IP'];`)).toEqual(['header CF-Connecting-IP']);
    expect(whats(`const key = req.socket.remoteAddress;`)).toEqual(['.remoteAddress']);
    expect(whats(`const key = req.headers['x-forwarded-for'];`)).toEqual(['header x-forwarded-for']);
    // the resolver may read the peer and the header, never the rest
    expect(findings(RESOLVER, `const a = req.socket.remoteAddress; const b = req.headers['x-forwarded-for'];`)).toEqual([]);
    expect(findings(RESOLVER, `const a = req.headers['x-real-ip'];`).map((x) => x.what)).toEqual(['header x-real-ip']);
  });
});
