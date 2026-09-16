import { MiddlewareConsumer, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLS_REQ, ClsModule, ClsService } from 'nestjs-cls';
import fastifyIp from 'fastify-ip';
import { PlatformAuditService } from './platform-audit.service';

/**
 * WHY the forwarder reads the socket and the raw header instead of `request.ip` (wiki-v2 #320).
 *
 * `AuditContext.ipAddress` is Docmost's `request.ip`, captured in middleware. It reaches the platform's
 * hash-chained audit log, so if a client can choose it, the chain faithfully preserves a forgery. The
 * claim that a client CAN choose it rests entirely on hook ordering, which is invisible at the call site
 * and would survive any amount of unit testing of the forwarder itself — so it is asserted here, against
 * a real Nest app wired the way `main.ts` wires one, rather than described in a comment.
 *
 * Two hooks compete to define `request.ip`:
 *   Nest's middie (`runMiddie`)  — registered by NestFactory.create; runs the whole middleware chain
 *   fastify-ip (`redefineIpDecorator`) — registered by main.ts AFTER that, so it runs LATER
 *
 * Because middie wins, middleware-time `request.ip` is Fastify's own `trustProxy: true` result: the
 * leftmost X-Forwarded-For token, NOT parsed as an address. fastify-ip's very different answer (an
 * `x-client-ip`-first scan) only lands at handler time. Both are client-controlled; neither is evidence.
 *
 * WHAT EACH HALF OF THIS FILE ACTUALLY GUARDS — they are not interchangeable:
 *   - The `main.ts` source pins are what catch a REORDERING or a changed `trustProxy` value. The boot
 *     block below constructs its own adapter and registers fastify-ip itself, so it does NOT observe
 *     main.ts; editing main.ts alone reds the pins, not the boot.
 *   - The boot block is the DEPENDENCY canary. It asserts the framework semantics the pins take for
 *     granted, so a Nest/Fastify/fastify-ip upgrade that silently changed hook order or `trustProxy`
 *     behaviour fails here even though every source pin still matches.
 */
describe('audit client-IP wiring (#320)', () => {
  const PEER = '172.31.20.10'; // the socket peer: in production always the ALB or the platform's loopback relay
  const CLIENT = '198.51.100.7';
  const PROXY = '107.22.62.237';

  describe('what main.ts actually hands Fastify', () => {
    const mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');

    it('still constructs the adapter with trustProxy: true', () => {
      // If this ever becomes a predicate or a hop count, middleware-time request.ip changes meaning and
      // the ordering assertions below need re-deriving before anything downstream is trusted.
      // Anchored to a code line: an unanchored pattern also matches the word inside a comment, so the
      // pin would keep passing after the real setting was changed or removed.
      expect(mainSrc).toMatch(/^\s*trustProxy:\s*true\s*,?\s*$/m);
    });

    it('still registers fastify-ip AFTER NestFactory.create', () => {
      const created = mainSrc.indexOf('NestFactory.create');
      const registered = mainSrc.indexOf('app.register(fastifyIp)');
      expect(created).toBeGreaterThanOrEqual(0);
      expect(registered).toBeGreaterThan(created);
    });
  });

  describe('hook order, observed on a real Nest app', () => {
    let app: NestFastifyApplication;
    let adapter: FastifyAdapter;
    let observed: { middlewareIp: unknown; socketPeer?: string } | null = null;

    beforeAll(async () => {
      @Module({})
      class WiringModule {
        configure(consumer: MiddlewareConsumer): void {
          consumer
            .apply((req: { ip?: unknown; socket?: { remoteAddress?: string } }, _res: unknown, next: () => void) => {
              // EXACTLY where AuditContextMiddleware reads `(req as any).ip`.
              observed = { middlewareIp: req.ip, socketPeer: req.socket?.remoteAddress };
              next();
            })
            .forRoutes('*');
        }
      }

      adapter = new FastifyAdapter({ trustProxy: true });
      app = await NestFactory.create<NestFastifyApplication>(WiringModule, adapter, { logger: false });
      await app.register(fastifyIp); // main.ts
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    const inject = async (headers: Record<string, string>) => {
      observed = null;
      await adapter.getInstance().inject({ method: 'GET', url: '/any', remoteAddress: PEER, headers });
      return observed!;
    };

    it('runs middie BEFORE fastify-ip, so middleware-time request.ip is Fastify’s, not fastify-ip’s', () => {
      const instance = adapter.getInstance() as unknown as Record<symbol, { onRequest?: Array<{ name?: string }> }>;
      const hooksKey = Object.getOwnPropertySymbols(instance).find((s) => String(s).toLowerCase().includes('hooks'));
      const names = (instance[hooksKey!].onRequest ?? []).map((f) => f.name || '(anonymous)');
      expect(names).toContain('runMiddie');
      expect(names).toContain('redefineIpDecorator');
      expect(names.indexOf('runMiddie')).toBeLessThan(names.indexOf('redefineIpDecorator'));
    });

    it('gives the middleware the LEFTMOST X-Forwarded-For token — the value a client writes', async () => {
      const seen = await inject({ 'x-forwarded-for': `${CLIENT}, ${PROXY}` });
      expect(seen.middlewareIp).toBe(CLIENT);
    });

    it('keeps a non-address verbatim, which is how arbitrary text reached the chain', async () => {
      // The shape #320 was opened for: Fastify never parses the token, so any comma-free string survives.
      const seen = await inject({ 'x-forwarded-for': `not-an-ip<script>, ${CLIENT}, ${PROXY}` });
      expect(seen.middlewareIp).toBe('not-an-ip<script>');
    });

    it('exposes the untouched socket peer alongside it — the evidence the forwarder actually sends', async () => {
      const seen = await inject({ 'x-forwarded-for': `${CLIENT}, ${PROXY}` });
      expect(seen.socketPeer).toBe(PEER);
    });
  });

  /**
   * The two preconditions that make `CLS_REQ` readable at all (#320 review round 1).
   *
   * Reading the request from CLS is what lets the fix live entirely in CCC-owned code and keeps
   * `common/middlewares/audit-context.middleware.ts` byte-identical to upstream. The trade is that the
   * fix now depends on upstream *configuration* (`app.module.ts` mounting `ClsModule`) and on a
   * third-party *default* (`saveReq`), neither of which the forwarder controls.
   *
   * Both were previously asserted only by a code comment, and every other test here injects a FAKE
   * `ClsService`. So if either lapsed, `clientEvidence()` would return `undefined` on every event, the
   * sink would fall back to the forgeable legacy `ipAddress`, and the whole suite would stay green —
   * the exact silent-regression shape this change exists to remove. Pinned here instead.
   */
  describe('the preconditions that make CLS_REQ readable', () => {
    it('app.module.ts still mounts ClsModule as middleware', () => {
      const appModuleSrc = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
      expect(appModuleSrc).toMatch(/ClsModule\.forRoot\(/);
      expect(appModuleSrc).toMatch(/middleware:\s*\{[^}]*mount:\s*true/s);
    });

    it('never configures saveReq at all, so the request is always in CLS', () => {
      // Deliberately stricter than "not false": `saveReq: someExpression` — an env flag, say — would
      // disable it in production while every test stayed green, since the probe below builds its own
      // config and the source pin would match nothing. The default is what we depend on, so the
      // assertion is that nobody has reached for the knob.
      const appModuleSrc = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
      expect(appModuleSrc).not.toMatch(/saveReq\s*:/);
    });

    it('actually populates CLS_REQ with the raw request, socket and headers intact', async () => {
      // The behavioural half: proves the library default still does what the comment claims, so a
      // nestjs-cls upgrade that flipped `saveReq` would red here rather than silently disarm the fix.
      let fromCls: unknown;

      @Module({ imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } })] })
      class ClsProbeModule {
        constructor(private readonly cls: ClsService) {}
        configure(consumer: MiddlewareConsumer): void {
          consumer
            .apply((_req: unknown, _res: unknown, next: () => void) => {
              fromCls = this.cls.get(CLS_REQ);
              next();
            })
            .forRoutes('*');
        }
      }

      const probeAdapter = new FastifyAdapter({ trustProxy: true });
      const probe = await NestFactory.create<NestFastifyApplication>(ClsProbeModule, probeAdapter, {
        logger: false,
      });
      await probe.init();
      try {
        await probeAdapter
          .getInstance()
          .inject({ method: 'GET', url: '/any', remoteAddress: PEER, headers: { 'x-forwarded-for': CLIENT } });
      } finally {
        await probe.close();
      }

      const req = fromCls as { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> };
      expect(req).toBeDefined();
      expect(req.socket?.remoteAddress).toBe(PEER);
      expect(req.headers?.['x-forwarded-for']).toBe(CLIENT);
    });
  });

  describe('the evidence the forwarder builds', () => {
    const makeService = (req: unknown) => {
      const cls = { get: (key: unknown) => (key === CLS_REQ ? req : undefined) };
      const client = { forward: jest.fn().mockResolvedValue(undefined) };
      return {
        service: new PlatformAuditService(cls as never, client as never),
        client,
      };
    };
    const forwarded = (client: { forward: jest.Mock }) => client.forward.mock.calls[0][0][0];
    const payload = { event: 'page.updated', resourceType: 'page' } as never;

    it('sends the socket peer and the RAW header, unparsed', () => {
      const req = { socket: { remoteAddress: PEER }, headers: { 'x-forwarded-for': `${CLIENT}, ${PROXY}` } };
      const { service, client } = makeService(req);
      service.log(payload);
      expect(forwarded(client).clientEvidence).toEqual({ socketPeer: PEER, forwardedFor: `${CLIENT}, ${PROXY}` });
    });

    it('sends exactly two keys and nothing else', () => {
      // The platform validates with forbidNonWhitelisted; one unknown nested key 400s the WHOLE batch
      // (up to 500 events) and this client swallows the failure as a warn. Extra keys are audit loss.
      const req = { socket: { remoteAddress: PEER }, headers: { 'x-forwarded-for': CLIENT } };
      const { service, client } = makeService(req);
      service.log(payload);
      expect(Object.keys(forwarded(client).clientEvidence).sort()).toEqual(['forwardedFor', 'socketPeer']);
    });

    it('omits the header when there is none, rather than sending an empty string', () => {
      const { service, client } = makeService({ socket: { remoteAddress: PEER }, headers: {} });
      service.log(payload);
      expect(forwarded(client).clientEvidence).toEqual({ socketPeer: PEER });
    });

    it('sends NOTHING when there is no socket peer, so a torn-down socket is not mislabelled a forgery', () => {
      // Together-or-neither: the platform treats supplied evidence as authoritative and records
      // `ipAddressRejected` when it cannot resolve a peer. forwardedFor alone would flag an infrastructure
      // condition as an attack, so we fall back to the legacy field instead.
      const { service, client } = makeService({ socket: {}, headers: { 'x-forwarded-for': CLIENT } });
      service.log(payload);
      expect(forwarded(client).clientEvidence).toBeUndefined();
    });

    it('sends nothing outside a request, where there is no request to claim anything about', () => {
      const { service, client } = makeService(undefined);
      service.log(payload);
      expect(forwarded(client).clientEvidence).toBeUndefined();
    });

    it('normalises a repeated header to the comma-joined form the platform walks', () => {
      // Node comma-joins repeated X-Forwarded-For lines, so the array branch is unreachable at runtime —
      // but the type is `string | string[]`, and narrowing it wrongly would ship "[object Object]".
      const req = { socket: { remoteAddress: PEER }, headers: { 'x-forwarded-for': [CLIENT, PROXY] } };
      const { service, client } = makeService(req);
      service.log(payload);
      expect(forwarded(client).clientEvidence.forwardedFor).toBe(`${CLIENT}, ${PROXY}`);
    });

    it('does NOT attach ambient evidence to a caller-supplied context', () => {
      // logWithContext/logBatchWithContext mean "I am telling you the context". Mixing in whatever
      // request happens to be on the stack would take the actor from the caller and the network origin
      // from somewhere else, then hash-chain the result. Today the only caller is the queue-backed
      // import worker, but IAuditService is upstream-owned and a future caller could run mid-request.
      const req = { socket: { remoteAddress: PEER }, headers: { 'x-forwarded-for': CLIENT } };
      const { service, client } = makeService(req);
      const explicit = { workspaceId: 'w1', actorId: 'u1', actorType: 'user' as const, ipAddress: '9.9.9.9' };

      service.logWithContext(payload, explicit);
      expect(forwarded(client).clientEvidence).toBeUndefined();
      expect(forwarded(client).ipAddress).toBe('9.9.9.9');

      client.forward.mockClear();
      service.logBatchWithContext([payload], explicit);
      expect(forwarded(client).clientEvidence).toBeUndefined();
    });

    it('attaches evidence to updateRetention, which is a real in-request admin action', () => {
      const req = { socket: { remoteAddress: PEER }, headers: { 'x-forwarded-for': CLIENT } };
      const { service, client } = makeService(req);
      service.updateRetention('ws-1', 90);
      expect(forwarded(client).clientEvidence).toEqual({ socketPeer: PEER, forwardedFor: CLIENT });
    });

    it('still sends the legacy ipAddress, so an older platform build keeps working', () => {
      const cls = {
        get: (key: unknown) =>
          key === CLS_REQ
            ? { socket: { remoteAddress: PEER }, headers: { 'x-forwarded-for': CLIENT } }
            : { workspaceId: 'w1', actorId: 'u1', actorType: 'user', ipAddress: CLIENT, userAgent: 'UA' },
      };
      const client = { forward: jest.fn().mockResolvedValue(undefined) };
      new PlatformAuditService(cls as never, client as never).log(payload);
      const event = client.forward.mock.calls[0][0][0];
      expect(event.ipAddress).toBe(CLIENT);
      expect(event.clientEvidence).toEqual({ socketPeer: PEER, forwardedFor: CLIENT });
    });
  });
});
