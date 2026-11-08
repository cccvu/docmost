import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  attachServiceCredential,
  RATE_PRINCIPAL_HEADER,
  rateLimitsFor,
  ServiceAuthGuard,
  serviceCredentialIdOf,
} from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { TokenBucketRateLimiter } from './service-rate-limit';

const SECRET = 'test-service-secret-0123456789ab';

function ctx(header?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-authz-service-secret': header },
      }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as any;
}

/** A context carrying a secret (null = none) and an optional rate principal, with a reply that records headers. */
function rctx(opts: { secret?: string | null; principal?: string }) {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const headers: Record<string, string> = {};
  if (secret !== null) headers['x-authz-service-secret'] = secret;
  if (opts.principal !== undefined) headers[RATE_PRINCIPAL_HEADER] = opts.principal;
  const reply = {
    headers: {} as Record<string, string>,
    header(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => reply }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as any;
  return { context, reply };
}

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const userA = `user:${uuid(9001)}`;
const userB = `user:${uuid(9002)}`;
const serviceC = `service:${uuid(9003)}`;

const limiterOf = (g: ServiceAuthGuard): TokenBucketRateLimiter => (g as any).limiter;

/** A guard whose limiter runs on a hand-driven clock (ms). */
function clockedGuard(scope: ServiceScope) {
  const clock = { t: 1_000 };
  const guard = new ServiceAuthGuard(reflectorReturning(scope));
  (guard as any).limiter = new TokenBucketRateLimiter(() => clock.t);
  return { guard, clock };
}

function exhaustAnon(g: ServiceAuthGuard): void {
  while (limiterOf(g).take([{ key: 'anon', limit: 600 }]).ok) {
    /* fill the single coarse anon bucket */
  }
}

// Reflector stub returning a fixed required scope (or undefined for "no scope declared").
function reflectorReturning(scope: ServiceScope | undefined): Reflector {
  return { getAllAndOverride: () => scope } as unknown as Reflector;
}

/**
 * Negative-authorization suite for the east-west service guard (least privilege, fail-closed). These are
 * exactly the "service endpoints as an omnipotent-secret backdoor" defenses the plan calls out.
 */
describe('ServiceAuthGuard', () => {
  const orig = process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
  afterAll(() => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = orig;
  });
  // Rate-limit refusals log a warn line; keep the test output quiet.
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('with a configured service secret', () => {
    beforeEach(() => {
      process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    });

    it('allows a matching secret that carries the route scope', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(g.canActivate(ctx(SECRET))).toBe(true);
    });

    // #616: the keyed space create binds its ledger entry to the credential that authenticated the call.
    it('records the admitting credential on the request — and only once it admitted it; a body/header cannot set it', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SpacesWrite));
      const onReq = (req: object) =>
        ({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => () => undefined, getClass: () => class {} }) as any;
      const ok = { headers: { 'x-authz-service-secret': SECRET }, body: { credentialId: 'forged' } };
      expect(serviceCredentialIdOf(ok)).toBeUndefined();
      expect(g.canActivate(onReq(ok))).toBe(true);
      expect(serviceCredentialIdOf(ok)).toBe('shared');
      const bad = { headers: { 'x-authz-service-secret': 'wrong', 'x-ccc-service-credential': 'shared' } };
      expect(() => g.canActivate(onReq(bad))).toThrow(UnauthorizedException);
      expect(serviceCredentialIdOf(bad)).toBeUndefined();
      expect(serviceCredentialIdOf({ cccServiceCredentialId: 'shared' })).toBeUndefined(); // only the private key counts
      const marked = {};
      attachServiceCredential(marked, 'x');
      expect(serviceCredentialIdOf(marked)).toBe('x');
    });

    it('401 on a missing secret header', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx(undefined))).toThrow(UnauthorizedException);
    });

    it('401 on a wrong secret', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx('not-the-secret'))).toThrow(UnauthorizedException);
    });

    it('403 (fail-closed) when the route declares NO scope — a bug is not an open door', () => {
      const g = new ServiceAuthGuard(reflectorReturning(undefined));
      expect(() => g.canActivate(ctx(SECRET))).toThrow(ForbiddenException);
    });

    it('403 when the credential lacks the route scope (least privilege, not mere secret possession)', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      // The shared transitional secret carries ALL scopes, so this branch is otherwise unreachable. Simulate
      // a future per-scope credential that holds ONLY users:provision, and require session:mint — the guard
      // must 403 (a valid secret is not a pass to a scope it doesn't hold). Pins the branch for when distinct
      // per-scope credentials are introduced (no guard redesign needed).
      (g as any).credentials = [
        { id: 'scoped', secret: SECRET, scopes: new Set([ServiceScope.UsersProvision]) },
      ];
      expect(() => g.canActivate(ctx(SECRET))).toThrow(ForbiddenException);
    });

    it('rejects a wrong secret of EQUAL length (exercises the constant-time compare, not the length guard)', () => {
      // The 'wrong secret' test above differs in length, so it short-circuits before timingSafeEqual. A
      // same-length wrong secret forces the constant-time comparison path itself to reject → 401.
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      const sameLenWrong = 'x'.repeat(SECRET.length);
      expect(sameLenWrong.length).toBe(SECRET.length);
      expect(() => g.canActivate(ctx(sameLenWrong))).toThrow(UnauthorizedException);
    });

    // F6 (companion #272): the UNAUTHENTICATED path is rate-limited too. Once the single coarse anon bucket
    // is exhausted, a wrong/missing-secret flood gets 429 (not an unbounded stream of cheap 401s) — the DoS
    // backstop now actually covers the pre-auth path.
    it('F6: rate-limits the unauthenticated (wrong-secret) path with 429 once the anon bucket is exhausted', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      exhaustAnon(g);
      let status: number | undefined;
      try {
        g.canActivate(ctx('wrong-secret'));
      } catch (e: any) {
        status = e.getStatus?.();
      }
      expect(status).toBe(429);
    });

    // F6 hardening: the anon bucket is a SINGLE constant key, NOT keyed on req.ip. Under `trustProxy: true`
    // req.ip is X-Forwarded-For-derived (attacker-controlled), so a per-IP key would let a spoofed XFF mint a
    // fresh budget per request (bypassing the backstop) AND grow the limiter Map without bound. A varying
    // req.ip must therefore NOT create new buckets — once 'anon' is exhausted, spoofed-IP requests still 429.
    it('F6: a spoofed/varying X-Forwarded-For (req.ip) cannot bypass the anon limit', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      exhaustAnon(g);
      const ctxWithIp = (ip: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({ headers: { 'x-authz-service-secret': 'wrong' }, ip }),
          }),
          getHandler: () => () => undefined,
          getClass: () => class {},
        }) as any;
      for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
        let status: number | undefined;
        try {
          g.canActivate(ctxWithIp(ip));
        } catch (e: any) {
          status = e.getStatus?.();
        }
        expect(status).toBe(429); // still throttled — no per-IP bucket to escape into
      }
      expect(limiterOf(g).size).toBe(1); // only `anon`
    });

    // F6: a valid credential is NOT starved by a flood of bad requests — the anon bucket and the
    // credential's buckets are separate keys.
    it('F6: a valid credential still passes even after the anon bucket is exhausted', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      exhaustAnon(g);
      expect(g.canActivate(ctx(SECRET))).toBe(true);
      expect(g.canActivate(rctx({ principal: userA }).context)).toBe(true);
    });
  });

  describe('rate limits (#780): per principal, global backstop, unattributed', () => {
    beforeEach(() => {
      process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    });

    const statusOf = (fn: () => unknown): number => {
      try {
        fn();
        return 200;
      } catch (e: any) {
        return e.getStatus?.() ?? 500;
      }
    };

    it('the sizes per scope: principal / global / unattributed', () => {
      expect(rateLimitsFor(ServiceScope.PagesRead)).toEqual({ principal: 6000, global: 60000, unattributed: 6000 });
      expect(rateLimitsFor(ServiceScope.PagesAuthzRead)).toEqual({ principal: 6000, global: 60000, unattributed: 6000 });
      expect(rateLimitsFor(ServiceScope.PagesImportRead)).toEqual({ principal: 120, global: 1200, unattributed: 120 });
      for (const scope of [ServiceScope.ChangesRead, ServiceScope.ContentRead, ServiceScope.ContentSearch, ServiceScope.AttachmentsRead]) {
        expect(rateLimitsFor(scope)).toEqual({ principal: 1200, global: 6000, unattributed: 600 });
      }
    });

    // The unattributed (background) bucket of each scope: exhausting it refuses only that scope's unattributed calls.
    it.each([
      [ServiceScope.PagesImportRead, 120],
      [ServiceScope.PagesRead, 6000],
      [ServiceScope.PagesAuthzRead, 6000],
      [ServiceScope.ChangesRead, 600],
    ])('%s: an unattributed call has its own bucket of %i', (scope, limit) => {
      const g = clockedGuard(scope);
      let admitted = 0;
      while (statusOf(() => g.guard.canActivate(ctx(SECRET))) === 200) admitted++;
      expect(admitted).toBe(limit);
      expect(statusOf(() => g.guard.canActivate(ctx(SECRET)))).toBe(429);
      // Another scope on the SAME limiter is untouched.
      const other = new ServiceAuthGuard(reflectorReturning(scope === ServiceScope.SessionMint ? ServiceScope.ChangesRead : ServiceScope.SessionMint));
      (other as any).limiter = limiterOf(g.guard);
      expect(other.canActivate(ctx(SECRET))).toBe(true);
    });

    it.each([ServiceScope.PagesRead, ServiceScope.PagesImportRead])(
      '%s: principal A exhausted does not refuse principal B',
      (scope) => {
        const { guard } = clockedGuard(scope);
        const cap = rateLimitsFor(scope).principal;
        let admitted = 0;
        while (statusOf(() => guard.canActivate(rctx({ principal: userA }).context)) === 200) admitted++;
        expect(admitted).toBe(cap);
        expect(statusOf(() => guard.canActivate(rctx({ principal: userA }).context))).toBe(429);
        expect(guard.canActivate(rctx({ principal: userB }).context)).toBe(true);
        expect(guard.canActivate(rctx({ principal: serviceC }).context)).toBe(true);
        expect(guard.canActivate(ctx(SECRET))).toBe(true); // unattributed too
      },
    );

    // One principal's buckets are per scope, and so is the global backstop: spending both on one scope leaves every
    // principal admitted on another scope under the same credential, in both directions.
    it('attributed buckets are per scope: a principal and the global spent on one scope refuse nothing on another', () => {
      const drain = (g: ServiceAuthGuard, scope: ServiceScope) => {
        const { principal, global } = rateLimitsFor(scope);
        // userA first (its own bucket), then fresh principals until the global is empty.
        for (let i = 0; i <= global / principal; i++) {
          const p = i === 0 ? userA : `user:${uuid(i)}`;
          while (statusOf(() => g.canActivate(rctx({ principal: p }).context)) === 200) {
            /* drain */
          }
        }
        expect(statusOf(() => g.canActivate(rctx({ principal: userA }).context))).toBe(429);
        expect(statusOf(() => g.canActivate(rctx({ principal: userB }).context))).toBe(429); // the global is empty
      };
      for (const [spent, other] of [
        [ServiceScope.PagesImportRead, ServiceScope.ChangesRead],
        [ServiceScope.ChangesRead, ServiceScope.PagesImportRead],
      ]) {
        const g = clockedGuard(spent).guard;
        drain(g, spent);
        const o = new ServiceAuthGuard(reflectorReturning(other));
        (o as any).limiter = limiterOf(g);
        for (const p of [userA, userB, serviceC]) expect(o.canActivate(rctx({ principal: p }).context)).toBe(true);
      }
    });

    // All or nothing at the guard: a refused principal call debits no bucket, so a throttled flooder (any rate, no
    // refill) never drains the shared global bucket the other principals use.
    it('a throttled principal never drains the global: its refused calls debit nothing', () => {
      const { guard } = clockedGuard(ServiceScope.PagesImportRead);
      const { principal, global } = rateLimitsFor(ServiceScope.PagesImportRead);
      for (let n = 0; n < principal; n++) expect(guard.canActivate(rctx({ principal: userA }).context)).toBe(true);
      for (let n = 0; n < global; n++) {
        expect(statusOf(() => guard.canActivate(rctx({ principal: userA }).context))).toBe(429);
      }
      expect(guard.canActivate(rctx({ principal: userB }).context)).toBe(true);
      expect(guard.canActivate(rctx({ principal: serviceC }).context)).toBe(true);
    });

    // The #731 A1 shape: one principal floods far past its cap for minutes; a second principal's sparse calls are
    // never refused, at any point in the flood (no shared bucket, no 60 s cliff).
    it.each([ServiceScope.PagesRead, ServiceScope.PagesImportRead])(
      '%s: A floods at 5x its cap for 3 minutes; B (one call per second) is never refused',
      (scope) => {
        const { guard, clock } = clockedGuard(scope);
        const cap = rateLimitsFor(scope).principal;
        const stepMs = 60_000 / (cap * 5);
        let aOk = 0;
        let aRefused = 0;
        let bRefused = 0;
        let nextB = 0;
        for (let t = 0; t < 180_000; t += stepMs) {
          clock.t = 1_000 + t;
          const s = statusOf(() => guard.canActivate(rctx({ principal: userA }).context));
          if (s === 200) aOk++;
          else {
            expect(s).toBe(429); // never a 503
            aRefused++;
          }
          if (t >= nextB) {
            nextB += 1_000;
            if (statusOf(() => guard.canActivate(rctx({ principal: userB }).context)) !== 200) bRefused++;
          }
        }
        expect(bRefused).toBe(0);
        expect(aRefused).toBeGreaterThan(0);
        // A gets its burst plus the steady refill (3 minutes at `cap`/min), no more.
        expect(aOk).toBeGreaterThanOrEqual(cap * 4 - 2);
        expect(aOk).toBeLessThanOrEqual(cap * 4 + 1);
      },
    );

    it('an attributed flood never debits the unattributed bucket, and an unattributed flood never refuses a principal', () => {
      const { guard } = clockedGuard(ServiceScope.PagesImportRead);
      const { principal, global } = rateLimitsFor(ServiceScope.PagesImportRead);
      // Saturate the global with many principals.
      for (let i = 0; i < global / principal; i++) {
        const p = `user:${uuid(i)}`;
        while (statusOf(() => guard.canActivate(rctx({ principal: p }).context)) === 200) {
          /* drain */
        }
      }
      expect(statusOf(() => guard.canActivate(rctx({ principal: userB }).context))).toBe(429); // global is empty
      let unattributed = 0;
      while (statusOf(() => guard.canActivate(ctx(SECRET))) === 200) unattributed++;
      expect(unattributed).toBe(rateLimitsFor(ServiceScope.PagesImportRead).unattributed); // untouched

      const fresh = clockedGuard(ServiceScope.PagesImportRead).guard;
      while (statusOf(() => fresh.canActivate(ctx(SECRET))) === 200) {
        /* drain the unattributed bucket */
      }
      expect(fresh.canActivate(rctx({ principal: userA }).context)).toBe(true);
    });

    // Past G (several principals each at their cap), everyone attributed is refused alike with 429 + Retry-After —
    // never a 503 — and capacity comes back token by token (60/G s each), not after a 60 s cliff.
    it('colluders saturating the global backstop: others get 429 (never 503) and recover by refill', () => {
      const { guard, clock } = clockedGuard(ServiceScope.PagesImportRead);
      const { principal, global } = rateLimitsFor(ServiceScope.PagesImportRead);
      for (let i = 0; i < global / principal; i++) {
        const p = `user:${uuid(i)}`;
        for (let n = 0; n < principal; n++) expect(guard.canActivate(rctx({ principal: p }).context)).toBe(true);
      }
      const r = rctx({ principal: userB });
      let err: any;
      try {
        guard.canActivate(r.context);
      } catch (e) {
        err = e;
      }
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toMatchObject({ code: 'rate_limited' });
      expect(r.reply.headers['Retry-After']).toBe('1');
      clock.t += 60_000 / global; // one global token back
      expect(guard.canActivate(rctx({ principal: userB }).context)).toBe(true);
      expect(statusOf(() => guard.canActivate(rctx({ principal: serviceC }).context))).toBe(429);
      clock.t += 6_000; // a tenth of a minute: a tenth of the global back, shared by whoever asks
      let admitted = 0;
      for (let i = 0; i < 1000; i++) {
        if (statusOf(() => guard.canActivate(rctx({ principal: i % 2 ? userB : serviceC }).context)) === 200) admitted++;
      }
      expect(admitted).toBe(global / 10);
    });

    it('a 429 carries code rate_limited and a Retry-After on the reply', () => {
      const { guard } = clockedGuard(ServiceScope.PagesImportRead);
      for (let i = 0; i < 120; i++) guard.canActivate(rctx({ principal: userA }).context);
      const r = rctx({ principal: userA });
      let err: any;
      try {
        guard.canActivate(r.context);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toEqual({ message: 'service rate limit exceeded', code: 'rate_limited' });
      expect(r.reply.headers['Retry-After']).toBe('1'); // 120/min: a token every 0.5 s
      // A context with no reply object (a non-HTTP caller) still gets the 429.
      const bare = { ...rctx({ principal: userA }).context, switchToHttp: () => ({ getRequest: rctx({ principal: userA }).context.switchToHttp().getRequest }) };
      expect(statusOf(() => guard.canActivate(bare))).toBe(429);
    });

    // #780: the anon refusal is a credential fault, not anyone's load: its own code, so the platform never reads it
    // as the caller's per-principal `rate_limited`.
    it('the anon 429 has its own code, service_auth_throttled, and a Retry-After', () => {
      const { guard } = clockedGuard(ServiceScope.SessionMint);
      exhaustAnon(guard);
      const r = rctx({ secret: 'wrong' });
      let err: any;
      try {
        guard.canActivate(r.context);
      } catch (e) {
        err = e;
      }
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toEqual({ message: 'service rate limit exceeded', code: 'service_auth_throttled' });
      expect(r.reply.headers['Retry-After']).toBe('1');
    });

    it.each<[string, unknown]>([
      ['empty', ''],
      ['no id', 'user:'],
      ['not a uuid', 'user:not-a-uuid'],
      ['unknown kind', `admin:${uuid(1)}`],
      ['upper-case kind', `USER:${uuid(1)}`],
      ['comma-joined repeat', `user:${uuid(1)}, user:${uuid(2)}`],
      ['leading space', ` user:${uuid(1)}`],
      ['trailing newline', `user:${uuid(1)}\n`],
      ['bare uuid', uuid(1)],
      ['an array', [`user:${uuid(1)}`]],
      ['a number', 42],
    ])('a malformed header (%s) is a 400 rate_principal_invalid that never echoes the value', (_label, value) => {
      const g = clockedGuard(ServiceScope.PagesRead).guard;
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-authz-service-secret': SECRET, [RATE_PRINCIPAL_HEADER]: value } }),
          getResponse: () => ({ header: () => undefined }),
        }),
        getHandler: () => () => undefined,
        getClass: () => class {},
      } as any;
      let err: any;
      try {
        g.canActivate(context);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const body = err.getResponse();
      expect(body.code).toBe('rate_principal_invalid');
      expect(JSON.stringify(body)).not.toContain(uuid(1));
      expect(JSON.stringify(body)).not.toContain('not-a-uuid');
      expect(limiterOf(g).size).toBe(0); // nothing charged
    });

    it('the header is read only after the secret and scope checks: bad secret → 401, no bucket for that principal', () => {
      const g = clockedGuard(ServiceScope.PagesRead).guard;
      expect(statusOf(() => g.canActivate(rctx({ secret: 'wrong', principal: userA }).context))).toBe(401);
      expect(statusOf(() => g.canActivate(rctx({ secret: null, principal: userA }).context))).toBe(401);
      // A malformed value is not even parsed before the secret check.
      expect(statusOf(() => g.canActivate(rctx({ secret: 'wrong', principal: 'garbage' }).context))).toBe(401);
      expect(limiterOf(g).size).toBe(1); // `anon` only
      expect(([...(limiterOf(g) as any).buckets.keys()] as string[]).some((k) => k.includes(userA))).toBe(false);
      // A credential lacking the scope: 403, never 400, never charged.
      const scoped = clockedGuard(ServiceScope.SessionMint).guard;
      (scoped as any).credentials = [{ id: 'scoped', secret: SECRET, scopes: new Set([ServiceScope.UsersProvision]) }];
      expect(statusOf(() => scoped.canActivate(rctx({ principal: 'garbage' }).context))).toBe(403);
      expect(limiterOf(scoped).size).toBe(0);
    });

    it('logs one SERVICE_BRIDGE_RATE_LIMITED line per bucket per minute, never the principal', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      warn.mockClear();
      try {
        const { guard, clock } = clockedGuard(ServiceScope.PagesImportRead);
        for (let i = 0; i < 120; i++) guard.canActivate(rctx({ principal: userA }).context);
        for (let i = 0; i < 50; i++) statusOf(() => guard.canActivate(rctx({ principal: userA }).context));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe('SERVICE_BRIDGE_RATE_LIMITED scope=pages:import:read bucket=principal');
        clock.t += 60_000;
        for (let i = 0; i < 200; i++) statusOf(() => guard.canActivate(rctx({ principal: userA }).context));
        expect(warn).toHaveBeenCalledTimes(2);
        const all = JSON.stringify(warn.mock.calls);
        expect(all).not.toContain(userA.slice(5));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('with a whitespace-only service secret (fail-closed, F6)', () => {
    beforeEach(() => {
      process.env.PLATFORM_AUTHZ_SERVICE_SECRET = '   ';
    });

    it('503 — a blank/whitespace secret is NOT a configured credential', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx('   '))).toThrow(ServiceUnavailableException);
    });
  });

  describe('with NO service secret configured (fail-closed)', () => {
    beforeEach(() => {
      delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    });

    it('503 — never "allow"', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx(SECRET))).toThrow(ServiceUnavailableException);
    });
  });
});
