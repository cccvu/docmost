import { Controller, Get, Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  cacheControlFor,
  mergeVary,
  registerClientStatic,
} from './client-static';

/**
 * CCC (#309). Boots a REAL Fastify through Nest, exactly like the sibling response-headers.spec.ts, and
 * serves a throw-away client/dist fixture through `registerClientStatic`. The assertions are on the wire
 * (bytes, status, headers), because the whole point of #309 is what the browser and the ALB actually see:
 * precompressed siblings negotiated by Accept-Encoding, a year-long immutable Cache-Control on Vite's
 * content-hashed `assets/` output, and revalidation everywhere else. A table-only test would pass while
 * @fastify/send quietly overwrote the policy with its own `public, max-age=0`.
 *
 * The test module also installs an `onRequest` hook that sets `Vary: Origin` on EVERY response through the
 * reply store — a stand-in for a plugin such as @fastify/cors. Fastify writes reply-store headers over raw
 * ones, so a naive raw `res.setHeader('Vary', …)` inside @fastify/static's `setHeaders` would be clobbered
 * by it; the Vary assertions below therefore prove an append-merge, on static files ONLY.
 */

/** What upstream static.module.ts sets on its `app.get('*')` SPA fallback — must stay byte-identical. */
const FALLBACK_CACHE_CONTROL = 'no-cache, no-store, must-revalidate';
const BROWSER_ACCEPT = 'gzip, deflate, br';
/** What the cors-like stand-in sets on every response, before the static routes exist. */
const FOREIGN_VARY = 'Origin';

let fixtureRoot: string;

@Controller()
class ApiProbeController {
  @Get('api-probe')
  probe() {
    return { ok: true };
  }
}

@Module({ controllers: [ApiProbeController] })
class ClientStaticProbeModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  async onModuleInit(): Promise<void> {
    const instance = this.adapterHost.httpAdapter.getInstance();
    // cors-like stand-in: a foreign Vary on every response, installed BEFORE registerClientStatic.
    instance.addHook('onRequest', (_req: unknown, reply: any, done: () => void) => {
      reply.header('vary', FOREIGN_VARY);
      done();
    });
    await registerClientStatic(instance, fixtureRoot);
    // Mimics upstream's SPA fallback (static.module.ts): anything that is not a static file gets index.html
    // with a no-store policy. The regression this spec guards is that policy surviving on a MISSING asset.
    instance.get('*', (_req: unknown, reply: any) =>
      reply
        .header('Cache-Control', FALLBACK_CACHE_CONTROL)
        .type('text/html')
        .send('<html>fallback</html>'),
    );
  }
}

type Siblings = 'none' | 'br' | 'both';

function writeFixture(root: string): void {
  const put = (rel: string, data: string | Buffer, siblings: Siblings = 'none') => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (siblings !== 'none') writeFileSync(`${abs}.br`, brotliCompressSync(buf));
    if (siblings === 'both') writeFileSync(`${abs}.gz`, gzipSync(buf));
  };

  // >= 2 KB of JS-looking text so the compressed siblings are meaningfully smaller than the original.
  const js = `// index-abc123\n${'export function f(n){return n+1}\n'.repeat(80)}`;
  const css = `body{margin:0}\n${'.a{color:red}\n'.repeat(60)}`;

  put('index.html', '<!doctype html><html><head><!--window-config--></head><body>app</body></html>');
  put('index-template.html', '<!doctype html><html><head><!--window-config--></head><body>template</body></html>');
  put('assets/index-abc123.js', js, 'both');
  put('assets/index-abc123.css', css, 'both');
  put('assets/br-only-deadbeef.js', js, 'br');
  put('assets/plain-cafe.js', js);
  put('locales/en-US/translation.json', JSON.stringify({ hello: 'world', bye: 'world' }), 'both');
  put('manifest.json', JSON.stringify({ name: 'wiki', start_url: '/' }));
  put('icons/favicon-32x32.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** Vary parsed as the list it is (RFC 9110 §12.5.5): lower-cased, trimmed member tokens. */
function varyTokens(res: LightMyRequestResponse): string[] {
  const raw = res.headers['vary'];
  const joined = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return joined
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** The static-file contract for Vary: both the foreign token and ours, each exactly once. */
function expectStaticVary(res: LightMyRequestResponse): void {
  const tokens = varyTokens(res);
  expect(tokens).toContain('accept-encoding');
  expect(tokens).toContain('origin');
  expect(new Set(tokens).size).toBe(tokens.length);
}

describe('registerClientStatic — SPA asset delivery (issue #309)', () => {
  let app: NestFastifyApplication;

  const file = (rel: string) => readFileSync(join(fixtureRoot, rel));
  const inject = (
    url: string,
    headers: Record<string, string> = {},
    method: 'GET' | 'HEAD' = 'GET',
  ) => app.inject({ method, url, headers });

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'ccc-client-static-'));
    writeFixture(fixtureRoot);
    const moduleRef = await Test.createTestingModule({
      imports: [ClientStaticProbeModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  describe('content-hashed assets under /assets', () => {
    it('serves the .br sibling when br is accepted: exact br bytes, immutable, Vary, ETag', async () => {
      const res = await inject('/assets/index-abc123.js', { 'accept-encoding': BROWSER_ACCEPT });
      const br = file('assets/index-abc123.js.br');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
      expect(res.rawPayload.equals(br)).toBe(true);
      expect(Number(res.headers['content-length'])).toBe(br.length);
      expect(res.headers['content-type']).toMatch(/^application\/javascript/);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
      expectStaticVary(res);
      expect(res.headers['etag']).toBeTruthy();
    });

    it('serves the .gz sibling when only gzip is accepted', async () => {
      const res = await inject('/assets/index-abc123.js', { 'accept-encoding': 'gzip' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.rawPayload.equals(file('assets/index-abc123.js.gz'))).toBe(true);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it('serves the identity file when no Accept-Encoding is sent', async () => {
      const res = await inject('/assets/index-abc123.js');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.rawPayload.equals(file('assets/index-abc123.js'))).toBe(true);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
      // Identity responses vary on Accept-Encoding too: a shared cache must not hand this body to a br client.
      expectStaticVary(res);
    });

    it('keeps the CSS content type on a precompressed stylesheet', async () => {
      const res = await inject('/assets/index-abc123.css', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
      expect(res.headers['content-type']).toMatch(/^text\/css/);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it('falls back to identity (200, not 404) when the only sibling is br but the client accepts gzip', async () => {
      const res = await inject('/assets/br-only-deadbeef.js', { 'accept-encoding': 'gzip' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.rawPayload.equals(file('assets/br-only-deadbeef.js'))).toBe(true);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it('serves an asset with no precompressed siblings as identity, still immutable', async () => {
      const res = await inject('/assets/plain-cafe.js', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.rawPayload.equals(file('assets/plain-cafe.js'))).toBe(true);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it('answers 304 with an empty body to If-None-Match carrying the br representation ETag', async () => {
      const first = await inject('/assets/index-abc123.js', { 'accept-encoding': BROWSER_ACCEPT });
      const etag = String(first.headers['etag']);
      const res = await inject('/assets/index-abc123.js', {
        'accept-encoding': BROWSER_ACCEPT,
        'if-none-match': etag,
      });
      expect(res.statusCode).toBe(304);
      expect(res.rawPayload.length).toBe(0);
      expectStaticVary(res);
    });

    it('HEAD carries the same Cache-Control and Vary with an empty body', async () => {
      const res = await inject('/assets/index-abc123.js', { 'accept-encoding': BROWSER_ACCEPT }, 'HEAD');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
      expectStaticVary(res);
      expect(res.rawPayload.length).toBe(0);
    });
  });

  describe('Vary is append-merged, never clobbered, and only on static files', () => {
    it('an asset carries BOTH the foreign Vary token and Accept-Encoding, appended in order', async () => {
      const res = await inject('/assets/index-abc123.js', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(varyTokens(res)).toEqual(['origin', 'accept-encoding']);
      expect(res.headers['vary']).toBe('Origin, Accept-Encoding');
    });

    it('the SPA fallback (a missing asset) does NOT gain Vary: Accept-Encoding', async () => {
      const res = await inject('/assets/does-not-exist.js', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.payload).toBe('<html>fallback</html>');
      expect(varyTokens(res)).not.toContain('accept-encoding');
      expect(res.headers['vary']).toBe(FOREIGN_VARY);
    });

    it('a JSON API route does NOT gain Vary: Accept-Encoding', async () => {
      const res = await inject('/api-probe', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(varyTokens(res)).not.toContain('accept-encoding');
      expect(res.headers['vary']).toBe(FOREIGN_VARY);
    });
  });

  describe('documents that must always revalidate', () => {
    it('GET /index.html is no-cache (never immutable) and is the real file, not a stale sibling', async () => {
      const res = await inject('/index.html', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.payload).toContain('<!--window-config-->');
    });

    it('GET / serves index.html under the same revalidate policy', async () => {
      const res = await inject('/', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.payload).toContain('<!--window-config-->');
    });

    it('locale bundles are served precompressed but revalidated, and honour If-None-Match', async () => {
      const res = await inject('/locales/en-US/translation.json', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
      expect(res.rawPayload.equals(file('locales/en-US/translation.json.br'))).toBe(true);
      expect(res.headers['cache-control']).toBe('no-cache');
      expectStaticVary(res);

      const again = await inject('/locales/en-US/translation.json', {
        'accept-encoding': BROWSER_ACCEPT,
        'if-none-match': String(res.headers['etag']),
      });
      expect(again.statusCode).toBe(304);
      expect(again.rawPayload.length).toBe(0);
    });

    it('manifest.json is identity + no-cache', async () => {
      const res = await inject('/manifest.json', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.rawPayload.equals(file('manifest.json'))).toBe(true);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('icons are identity + no-cache', async () => {
      const res = await inject('/icons/favicon-32x32.png', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/^image\/png/);
      expect(res.rawPayload.equals(file('icons/favicon-32x32.png'))).toBe(true);
      expect(res.headers['cache-control']).toBe('no-cache');
    });
  });

  describe('what is NOT a static route', () => {
    it('does not expose a .br sibling as its own route (falls through to the SPA fallback)', async () => {
      const res = await inject('/assets/index-abc123.js.br');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.payload).toBe('<html>fallback</html>');
      expect(res.headers['cache-control']).toBe(FALLBACK_CACHE_CONTROL);
    });

    it('a MISSING asset falls through to the SPA fallback and KEEPS its no-store policy (GET)', async () => {
      // Load-bearing regression: a blanket immutable policy on the /assets prefix would let a 404 HTML
      // fallback be cached for a year under an asset URL. The policy must ride on real files only.
      const res = await inject('/assets/does-not-exist.js', { 'accept-encoding': BROWSER_ACCEPT });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toBe('<html>fallback</html>');
      expect(res.headers['cache-control']).toBe(FALLBACK_CACHE_CONTROL);
      expect(res.headers['cache-control']).not.toContain('immutable');
    });

    it('a MISSING asset falls through to the SPA fallback and KEEPS its no-store policy (HEAD)', async () => {
      const res = await inject('/assets/does-not-exist.js', { 'accept-encoding': BROWSER_ACCEPT }, 'HEAD');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(FALLBACK_CACHE_CONTROL);
      expect(res.headers['cache-control']).not.toContain('immutable');
      expect(res.rawPayload.length).toBe(0);
    });

    it('index-template.html is not routable (upstream keeps the pristine template on disk only)', async () => {
      const res = await inject('/index-template.html');
      expect(res.statusCode).toBe(200);
      expect(res.payload).toBe('<html>fallback</html>');
      expect(res.headers['cache-control']).toBe(FALLBACK_CACHE_CONTROL);
    });
  });

  describe('cacheControlFor (pure policy, no HTTP)', () => {
    const root = join(tmpdir(), 'ccc-policy-root');

    it('is immutable for a file inside assets/', () => {
      expect(cacheControlFor(root, join(root, 'assets', 'x.js'))).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it('is immutable for a precompressed sibling inside assets/ (suffix normalised away)', () => {
      expect(cacheControlFor(root, join(root, 'assets', 'x.js.br'))).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(cacheControlFor(root, join(root, 'assets', 'x.js.gz'))).toBe(IMMUTABLE_CACHE_CONTROL);
    });

    it('is no-cache for index.html and locale bundles', () => {
      expect(cacheControlFor(root, join(root, 'index.html'))).toBe('no-cache');
      expect(cacheControlFor(root, join(root, 'locales', 'en-US', 'translation.json'))).toBe('no-cache');
      expect(REVALIDATE_CACHE_CONTROL).toBe('no-cache');
    });

    it('is no-cache for a path outside the root (never immutable by accident)', () => {
      expect(cacheControlFor(root, join(root, '..', 'assets', 'x.js'))).toBe('no-cache');
      expect(cacheControlFor(root, '/elsewhere/assets/x.js')).toBe('no-cache');
    });

    it('pins the immutable value the ALB and browsers will see', () => {
      expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    });
  });

  describe('mergeVary (pure, no HTTP)', () => {
    const T = 'Accept-Encoding';

    it('absent or empty -> just the token', () => {
      expect(mergeVary(undefined, T)).toBe('Accept-Encoding');
      expect(mergeVary('', T)).toBe('Accept-Encoding');
    });

    it('appends after a foreign token', () => {
      expect(mergeVary('Origin', T)).toBe('Origin, Accept-Encoding');
      expect(mergeVary('Origin, Accept-Language', T)).toBe('Origin, Accept-Language, Accept-Encoding');
    });

    it('dedupes case-insensitively and leaves the existing value untouched', () => {
      expect(mergeVary('Accept-Encoding', T)).toBe('Accept-Encoding');
      expect(mergeVary('Origin, accept-encoding', T)).toBe('Origin, accept-encoding');
      expect(mergeVary(' origin ,ACCEPT-ENCODING ', T)).toBe(' origin ,ACCEPT-ENCODING ');
    });

    it('* stays *', () => {
      expect(mergeVary('*', T)).toBe('*');
      expect(mergeVary('Origin, *', T)).toBe('Origin, *');
    });

    it('accepts a multi-valued header (string[]) as Fastify may hand it back', () => {
      expect(mergeVary(['Origin', 'Accept-Language'], T)).toBe('Origin, Accept-Language, Accept-Encoding');
      expect(mergeVary(['Origin', 'accept-encoding'], T)).toBe('Origin, accept-encoding');
    });
  });
});
