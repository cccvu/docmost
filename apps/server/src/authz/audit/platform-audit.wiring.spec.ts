import { MiddlewareConsumer, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLS_REQ } from 'nestjs-cls';
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
      expect(mainSrc).toMatch(/trustProxy:\s*true/);
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
