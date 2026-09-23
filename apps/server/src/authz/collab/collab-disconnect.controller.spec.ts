import {
  ServiceUnavailableException,
  UnauthorizedException,
  ExecutionContext,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as crypto from 'crypto';

// The controller only uses CollaborationGateway as a constructor TYPE, but NestJS emits its runtime
// require for DI metadata — which transitively pulls in the collab WebSocket stack (lib0 ESM) that
// jest cannot parse. Stub the module so the heavy graph never loads; every test injects its own fake.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));
// Same DI-metadata reason for WsGateway (its runtime require pulls the socket.io/notifications stack).
// Stub it; every test injects its own fake.
jest.mock('../../ws/ws.gateway', () => ({
  WsGateway: class {},
}));

// Same reason for the revalidator: its runtime require pulls the gateways. Stub it; tests inject a fake.
jest.mock('../live-access/live-access.revalidator', () => ({
  LiveAccessRevalidator: class {},
}));

import {
  CollabDisconnectController,
  ForceDisconnectUserDto,
} from './collab-disconnect.controller';
import { CollabServiceSecretGuard } from './service-secret.guard';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';

/**
 * CCC authorization integration test (part of the fork's compatibility suite).
 *
 * The inbound mid-session collab-revocation seam. Intended behavior is drawn from the two source
 * doc-comments + CLAUDE.md's deny-by-default / fail-closed rules:
 *   - service-secret.guard.ts: verify `x-authz-service-secret` with a CONSTANT-TIME compare
 *     (timingSafeEqual), and FAIL CLOSED when the secret is unconfigured;
 *   - collab-disconnect.controller.ts: `revalidate` hands off to the live-access revalidator (which re-checks
 *     every live connection and only narrows) and answers with the pass summary, or `{pending:true}` if the
 *     pass outlives the bound; `force-disconnect-user` closes one identity's sockets on both planes;
 *   - ForceDisconnectUserDto: userId is a UUID.
 *
 * Pure unit specs (no Nest app, no Docker), instantiating the classes directly — mirroring
 * authz/audit/platform-audit.service.spec.ts and authz/search/pdp-search.service.spec.ts.
 */

// Minimal ExecutionContext exposing a request with the given headers.
const ctxWith = (headers: Record<string, unknown>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as any;

describe('CollabServiceSecretGuard (x-authz-service-secret verification)', () => {
  const SECRET = 'platform-shared-secret-abcdef';
  const HEADER = 'x-authz-service-secret';
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    jest.restoreAllMocks();
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    else process.env.PLATFORM_AUTHZ_SERVICE_SECRET = savedSecret;
  });

  // Invariant: fail closed when the shared secret is unconfigured (guard doc-comment; CLAUDE.md
  // deny-by-default). A blank env must never authorize the endpoint.
  it('fails CLOSED (ServiceUnavailable) when the service secret is not configured', () => {
    delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    const guard = new CollabServiceSecretGuard();
    expect(() => guard.canActivate(ctxWith({ [HEADER]: 'anything' }))).toThrow(
      ServiceUnavailableException,
    );
  });

  // Invariant (a): a MISSING header is rejected.
  it('rejects a request with a MISSING service-secret header (Unauthorized)', () => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    const guard = new CollabServiceSecretGuard();
    expect(() => guard.canActivate(ctxWith({}))).toThrow(UnauthorizedException);
  });

  // Invariant (a): a WRONG secret is rejected. Uses a same-length wrong value so the compare is
  // forced onto the constant-time path (a length mismatch would short-circuit before it).
  it('rejects a WRONG service secret of the same length (Unauthorized)', () => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    const guard = new CollabServiceSecretGuard();
    const wrong = 'X'.repeat(SECRET.length); // same length, different bytes
    expect(() => guard.canActivate(ctxWith({ [HEADER]: wrong }))).toThrow(
      UnauthorizedException,
    );
  });

  // Invariant (a): a wrong secret of DIFFERENT length is still rejected (and must not throw the
  // TypeError that timingSafeEqual raises on unequal-length buffers — the guard length-guards first).
  it('rejects a WRONG service secret of a different length without a comparison error', () => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    const guard = new CollabServiceSecretGuard();
    expect(() => guard.canActivate(ctxWith({ [HEADER]: 'short' }))).toThrow(
      UnauthorizedException,
    );
  });

  // Invariant (a): a non-string header value (e.g. duplicated header → array) is rejected.
  it('rejects a non-string service-secret header value (Unauthorized)', () => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    const guard = new CollabServiceSecretGuard();
    expect(() =>
      guard.canActivate(ctxWith({ [HEADER]: [SECRET, SECRET] })),
    ).toThrow(UnauthorizedException);
  });

  // Invariant (a): the CORRECT secret is accepted.
  it('accepts the CORRECT service secret', () => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    const guard = new CollabServiceSecretGuard();
    expect(guard.canActivate(ctxWith({ [HEADER]: SECRET }))).toBe(true);
  });

  // Invariant (a): the compare is CONSTANT-TIME — it routes through crypto.timingSafeEqual, not `===`.
  // Proven by spying on timingSafeEqual and confirming it is invoked on a same-length comparison.
  it('uses a constant-time compare (crypto.timingSafeEqual), not string equality', () => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    const spy = jest.spyOn(crypto, 'timingSafeEqual'); // spy but call through
    const guard = new CollabServiceSecretGuard();

    // A same-length wrong secret must reach the constant-time comparator (a `===` impl never would).
    expect(() =>
      guard.canActivate(ctxWith({ [HEADER]: 'X'.repeat(SECRET.length) })),
    ).toThrow(UnauthorizedException);
    expect(spy).toHaveBeenCalled();

    // And the accepting path also goes through it.
    spy.mockClear();
    expect(guard.canActivate(ctxWith({ [HEADER]: SECRET }))).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});

describe('CollabDisconnectController.revalidate (#501 — narrow every live connection after a revocation)', () => {
  const summary = { checked: 3, closed: 1, left: 1, disconnected: 0, unknown: 0, unknownClosed: 0 };

  it('hands off to the revalidator as a fast-path signal and returns the pass summary', async () => {
    const signal = jest.fn(async () => summary);
    const controller = new CollabDisconnectController({} as any, {} as any, { signal } as any);
    await expect(controller.revalidate()).resolves.toEqual(summary);
    expect(signal).toHaveBeenCalledWith('signal');
  });

  it('answers {pending:true} when the pass outlives the 5s bound (the sweep still covers it)', async () => {
    jest.useFakeTimers();
    try {
      const signal = jest.fn(() => new Promise(() => undefined)); // never settles
      const controller = new CollabDisconnectController({} as any, {} as any, { signal } as any);
      const p = controller.revalidate();
      await jest.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toEqual({ pending: true });
    } finally {
      jest.useRealTimers();
    }
  });

  // A PDP or fork-DB failure does NOT reach here: the revalidator reads it as `unknown` (see its spec). A pass
  // only rejects on an unexpected fault (a code defect, a gateway throwing) — which must still surface.
  it('propagates an unexpected pass failure as an error (the platform logs it; the sweep retries)', async () => {
    const signal = jest.fn(async () => {
      throw new TypeError('gateway exploded');
    });
    const controller = new CollabDisconnectController({} as any, {} as any, { signal } as any);
    await expect(controller.revalidate()).rejects.toThrow('gateway exploded');
  });

  it('the per-page force-disconnect route is gone (replaced by revalidate)', () => {
    expect((CollabDisconnectController.prototype as any).forceDisconnect).toBeUndefined();
  });
});

describe('CollabDisconnectController.forceDisconnectUser (#455 — account-disable, all pages)', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  const build = () => {
    const forceDisconnectUser = jest.fn(); // collab gateway (Hocuspocus)
    const wsForceDisconnectUser = jest.fn(); // ws gateway (socket.io notifications/tree)
    const signal = jest.fn();
    const controller = new CollabDisconnectController(
      { forceDisconnectUser } as any,
      { forceDisconnectUser: wsForceDisconnectUser } as any,
      { signal } as any,
    );
    return { controller, forceDisconnectUser, wsForceDisconnectUser, signal };
  };

  // Unlike the per-page force-disconnect, this is a whole-identity signal (the platform already deactivated
  // the shadow user), so it closes UNCONDITIONALLY — no page-access re-check, no pageId — across BOTH the
  // collab editor sockets AND the notifications/tree sockets (the #455 residual the ws gate alone can't cut,
  // since it only refuses NEW connections).
  it('unconditionally force-disconnects the user across BOTH realtime planes and returns {disconnected:true}', async () => {
    const { controller, forceDisconnectUser, wsForceDisconnectUser, signal } = build();

    const result = await controller.forceDisconnectUser({ userId: USER });

    expect(result).toEqual({ disconnected: true });
    expect(forceDisconnectUser).toHaveBeenCalledTimes(1);
    expect(forceDisconnectUser).toHaveBeenCalledWith(USER);
    // The notifications/tree socket.io plane is also force-closed (not just the collab editor).
    expect(wsForceDisconnectUser).toHaveBeenCalledTimes(1);
    expect(wsForceDisconnectUser).toHaveBeenCalledWith(USER);
    // No PDP re-check — the deactivate already happened; this is not a revalidation.
    expect(signal).not.toHaveBeenCalled();
  });

  it('carries @SkipTransform() so the body is bare per the spec', () => {
    expect(
      Reflect.getMetadata(
        SKIP_TRANSFORM_KEY,
        CollabDisconnectController.prototype.forceDisconnectUser,
      ),
    ).toBe(true);
  });
});

describe('ForceDisconnectUserDto validation (userId is a UUID)', () => {
  const UUID = '33333333-3333-4333-8333-333333333333';
  const errorsFor = (obj: Record<string, unknown>) =>
    validate(plainToInstance(ForceDisconnectUserDto, obj));

  it('accepts a valid UUID userId', async () => {
    expect(await errorsFor({ userId: UUID })).toHaveLength(0);
  });

  it('rejects a non-UUID userId', async () => {
    const errors = await errorsFor({ userId: 'nope' });
    expect(errors.map((e) => e.property)).toContain('userId');
  });

  it('rejects a missing userId (no empty disconnect payload)', async () => {
    const errors = await errorsFor({});
    expect(errors.map((e) => e.property)).toContain('userId');
  });
});

describe('CollabDisconnectController wire shape (incident #181)', () => {
  it('revalidate carries @SkipTransform() so the body is bare per service-bridge.openapi.json', () => {
    expect(
      Reflect.getMetadata(SKIP_TRANSFORM_KEY, CollabDisconnectController.prototype.revalidate),
    ).toBe(true);
  });
});
