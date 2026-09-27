import { CallHandler, ExecutionContext, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import type { AuthzMode } from '../mode/authz-mode';
import {
  NATIVE_SPACE_CREATE_ROUTES,
  SPACE_NATIVE_CREATE_REFUSED_EVENT,
  SpaceNativeCreateInterceptor,
} from './space-native-create.interceptor';

/**
 * SpaceNativeCreateInterceptor (#598) — NOT upstream Docmost code.
 *
 * In `AUTHZ_MODE=remote` the engine's native space create is refused (404) for every authenticated caller, before the
 * handler (so before CASL and the insert), and the refusal is audited without reading the body. Everything else —
 * another route, native mode, a non-HTTP context — passes through untouched and writes no row.
 */
class SpaceController {
  createSpace() {}
  deleteSpace() {}
  updateSpace() {}
}
class OtherController {
  createSpace() {}
}

const USER_ID = '0198c2a1-0000-7000-8000-000000000001';
const WORKSPACE_ID = '0198c2a1-0000-7000-8000-0000000000aa';
const BODY = { name: 'Secret Project Falcon', slug: 'falcon-private' };
const NO_ROLE = Symbol('no role');

type Req = {
  body?: unknown;
  user?: { user?: { id?: string; role?: unknown }; workspace?: { id?: string } };
  headers?: Record<string, string>;
  raw?: { socket?: { remoteAddress?: string }; headers?: Record<string, string> };
};

const authedReq = (body: unknown, role: unknown = 'member'): Req => ({
  body,
  user: { user: { id: USER_ID, role }, workspace: { id: WORKSPACE_ID } },
  headers: { 'user-agent': 'jest-agent' },
  raw: { socket: { remoteAddress: '10.0.0.7' }, headers: { 'x-forwarded-for': '203.0.113.9' } },
});

const ctx = (target: object, handler: unknown, req: Req, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    getClass: () => target,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

function setup(mode: AuthzMode, forward?: jest.Mock) {
  const fwd = forward ?? jest.fn().mockResolvedValue(undefined);
  const client = { forward: fwd } as unknown as PlatformAuditClient;
  const interceptor = new SpaceNativeCreateInterceptor(mode, client);
  const handler = jest.fn(() => of('handled'));
  const next: CallHandler = { handle: handler };
  return { interceptor, next, handler, forward: fwd };
}

const refusedCreate = (req: Req) => ctx(SpaceController, SpaceController.prototype.createSpace, req);

async function expect404(interceptor: SpaceNativeCreateInterceptor, context: ExecutionContext, next: CallHandler) {
  await expect(lastValueFrom(interceptor.intercept(context, next))).rejects.toBeInstanceOf(NotFoundException);
}

describe('SpaceNativeCreateInterceptor (#598)', () => {
  it('refuses exactly SpaceController.createSpace', () => {
    expect([...NATIVE_SPACE_CREATE_ROUTES]).toEqual(['SpaceController.createSpace']);
    expect(SPACE_NATIVE_CREATE_REFUSED_EVENT).toBe('space.native_create_refused');
  });

  describe('AUTHZ_MODE=remote, POST /api/spaces/create', () => {
    it('404s before the handler and forwards exactly one refusal row with the actor', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect404(interceptor, refusedCreate(authedReq(BODY)), next);

      expect(handler).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledTimes(1);
      const [events] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(events).toEqual([
        {
          event: SPACE_NATIVE_CREATE_REFUSED_EVENT,
          resourceType: 'space',
          actorId: USER_ID,
          actorType: 'user',
          workspaceId: WORKSPACE_ID,
          clientEvidence: { socketPeer: '10.0.0.7', forwardedFor: '203.0.113.9' },
          userAgent: 'jest-agent',
          metadata: {
            outcome: 'denied',
            reason: 'platform_only',
            route: 'POST /api/spaces/create',
            actorRole: 'member',
          },
        },
      ]);
    });

    it('refuses a privileged engine role too (it does not depend on users.role) and records it', async () => {
      for (const role of ['owner', 'admin']) {
        const { interceptor, next, handler, forward } = setup('remote');
        await expect404(interceptor, refusedCreate(authedReq(BODY, role)), next);
        expect(handler).not.toHaveBeenCalled();
        const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
        expect(row.metadata).toMatchObject({ actorRole: role });
      }
    });

    it.each([
      ['an unknown role string', 'superuser'],
      ['a non-string role', { $ne: null }],
      ['no role', NO_ROLE],
    ])('records the role only as a known enum value (%s → omitted)', async (_label, role) => {
      const { interceptor, next, forward } = setup('remote');
      const req = authedReq(BODY, role);
      if (role === NO_ROLE) delete req.user!.user!.role;
      await expect404(interceptor, refusedCreate(req), next);
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).toEqual({ outcome: 'denied', reason: 'platform_only', route: 'POST /api/spaces/create' });
    });

    it.each([
      ['a valid body', BODY],
      ['an empty body', {}],
      ['a null body', null],
      ['an array body', [BODY]],
      ['an oversized name', { name: 'x'.repeat(10_000), slug: 'falcon-private' }],
      ['no body at all', undefined],
    ])('404s %s and never echoes the body into the audit row', async (_label, body) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect404(interceptor, refusedCreate(authedReq(body)), next);
      expect(handler).not.toHaveBeenCalled();
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row).not.toHaveProperty('resourceId');
      expect(row).not.toHaveProperty('spaceId');
      const text = JSON.stringify(row);
      expect(text).not.toContain('Falcon');
      expect(text).not.toContain('falcon-private');
      expect(text).not.toContain('xxxxxxxx');
    });

    it('never reads the body (a throwing body getter still gives the 404 and the row)', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      const req = authedReq(undefined);
      Object.defineProperty(req, 'body', {
        get() {
          throw new Error('the refusal must not read the body');
        },
      });
      await expect404(interceptor, refusedCreate(req), next);
      expect(handler).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledTimes(1);
    });

    it('still 404s, and writes no unattributable row, when there is no authenticated user', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect404(interceptor, refusedCreate({ body: BODY }), next);
      expect(handler).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    });

    it('a failing audit forward never changes the outcome (still 404, no unhandled rejection)', async () => {
      const { interceptor, next, handler } = setup('remote', jest.fn().mockRejectedValue(new Error('sink down')));
      await expect404(interceptor, refusedCreate(authedReq(BODY)), next);
      expect(handler).not.toHaveBeenCalled();
    });

    it('a forward that throws synchronously never changes the outcome either', async () => {
      const { interceptor, next, handler } = setup(
        'remote',
        jest.fn(() => {
          throw new Error('boom');
        }),
      );
      await expect404(interceptor, refusedCreate(authedReq(BODY)), next);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('everything else passes through with no row', () => {
    it.each([
      ['the native delete (the #502 interceptor owns it)', ctx(SpaceController, SpaceController.prototype.deleteSpace, authedReq({}))],
      ['another handler on SpaceController', ctx(SpaceController, SpaceController.prototype.updateSpace, authedReq(BODY))],
      ['a same-named handler on another controller', ctx(OtherController, OtherController.prototype.createSpace, authedReq(BODY))],
      ['a non-HTTP context', ctx(SpaceController, SpaceController.prototype.createSpace, authedReq(BODY), 'ws')],
    ])('remote: %s', async (_label, context) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });

    it('native mode: the upstream create stays reachable (standalone)', async () => {
      const { interceptor, next, handler, forward } = setup('native');
      await expect(lastValueFrom(interceptor.intercept(refusedCreate(authedReq(BODY, 'owner')), next))).resolves.toBe(
        'handled',
      );
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });
  });
});
