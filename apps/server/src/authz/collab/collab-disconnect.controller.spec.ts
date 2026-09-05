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

import {
  CollabDisconnectController,
  ForceDisconnectDto,
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
 *   - collab-disconnect.controller.ts: FAIL-SAFE re-check — "never disconnect a user who still has
 *     access" (re-run the rebound PDP repo before routing a force-disconnect);
 *   - ForceDisconnectDto: userId/pageId are UUIDs.
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

describe('CollabDisconnectController.forceDisconnect (fail-safe PDP re-check)', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const PAGE = '22222222-2222-4222-8222-222222222222';

  const build = (canAccess: boolean) => {
    const forceDisconnectUserFromPage = jest.fn();
    const canUserAccessPage = jest.fn(async () => canAccess);
    const controller = new CollabDisconnectController(
      { forceDisconnectUserFromPage } as any,
      { canUserAccessPage } as any,
    );
    return { controller, forceDisconnectUserFromPage, canUserAccessPage };
  };

  // Invariant (b): fail-safe — if the user is STILL authorized on the page, do NOT disconnect.
  // "never disconnect a user who still has access" (controller doc-comment). The stale/coarse signal
  // must not sever a live, still-permitted session.
  it('does NOT disconnect and returns {disconnected:false} when the user is STILL authorized', async () => {
    const { controller, forceDisconnectUserFromPage, canUserAccessPage } = build(true);

    const result = await controller.forceDisconnect({ userId: USER, pageId: PAGE });

    expect(result).toEqual({ disconnected: false });
    expect(forceDisconnectUserFromPage).not.toHaveBeenCalled();
    // The re-check must actually be performed (not skipped) with the DTO's user+page.
    expect(canUserAccessPage).toHaveBeenCalledWith(USER, PAGE);
  });

  // Invariant (b): when access is revoked (re-check false), route the force-disconnect and report true.
  it('routes the force-disconnect and returns {disconnected:true} when the user is NO LONGER authorized', async () => {
    const { controller, forceDisconnectUserFromPage, canUserAccessPage } = build(false);

    const result = await controller.forceDisconnect({ userId: USER, pageId: PAGE });

    expect(result).toEqual({ disconnected: true });
    expect(canUserAccessPage).toHaveBeenCalledWith(USER, PAGE);
    // Gateway signature is (pageId, userId) — assert the order the seam expects.
    expect(forceDisconnectUserFromPage).toHaveBeenCalledTimes(1);
    expect(forceDisconnectUserFromPage).toHaveBeenCalledWith(PAGE, USER);
  });

  // Invariant (b): the re-check gates the disconnect — it is consulted BEFORE the gateway is touched.
  it('consults the PDP re-check before invoking the gateway (re-check gates the action)', async () => {
    const order: string[] = [];
    const forceDisconnectUserFromPage = jest.fn(() => order.push('gateway'));
    const canUserAccessPage = jest.fn(async () => {
      order.push('recheck');
      return false;
    });
    const controller = new CollabDisconnectController(
      { forceDisconnectUserFromPage } as any,
      { canUserAccessPage } as any,
    );

    await controller.forceDisconnect({ userId: USER, pageId: PAGE });

    expect(order).toEqual(['recheck', 'gateway']);
  });
});

describe('ForceDisconnectDto validation (userId/pageId are UUIDs)', () => {
  const UUID = '33333333-3333-4333-8333-333333333333';

  const errorsFor = (obj: Record<string, unknown>) =>
    validate(plainToInstance(ForceDisconnectDto, obj));

  // Invariant (c): well-formed UUIDs pass.
  it('accepts a payload with valid UUID userId and pageId', async () => {
    const errors = await errorsFor({ userId: UUID, pageId: UUID });
    expect(errors).toHaveLength(0);
  });

  // Invariant (c): a non-UUID userId is rejected.
  it('rejects a non-UUID userId', async () => {
    const errors = await errorsFor({ userId: 'not-a-uuid', pageId: UUID });
    expect(errors.map((e) => e.property)).toContain('userId');
  });

  // Invariant (c): a non-UUID pageId is rejected.
  it('rejects a non-UUID pageId', async () => {
    const errors = await errorsFor({ userId: UUID, pageId: '42' });
    expect(errors.map((e) => e.property)).toContain('pageId');
  });

  // Invariant (c): missing fields are rejected (no unauthenticated/empty disconnect payloads).
  it('rejects a payload missing both fields', async () => {
    const errors = await errorsFor({});
    const props = errors.map((e) => e.property);
    expect(props).toContain('userId');
    expect(props).toContain('pageId');
  });
});

describe('CollabDisconnectController wire shape (incident #181)', () => {
  it('forceDisconnect carries @SkipTransform() so the body is bare per service-bridge.openapi.json', () => {
    expect(
      Reflect.getMetadata(SKIP_TRANSFORM_KEY, CollabDisconnectController.prototype.forceDisconnect),
    ).toBe(true);
  });
});
