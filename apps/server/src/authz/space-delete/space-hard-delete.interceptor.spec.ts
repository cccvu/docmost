import { CallHandler, ExecutionContext, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import type { AuthzMode } from '../mode/authz-mode';
import {
  SPACE_HARD_DELETE_REFUSED_EVENT,
  SPACE_HARD_DELETE_ROUTES,
  SpaceHardDeleteInterceptor,
} from './space-hard-delete.interceptor';

/**
 * SpaceHardDeleteInterceptor (#502) — NOT upstream Docmost code.
 *
 * In `AUTHZ_MODE=remote` the engine's native space delete is refused (404) for every caller, before the handler
 * (so before CASL and before the `DELETE FROM spaces`), and the refusal is audited. Everything else — another route,
 * native mode, a non-HTTP context — passes through untouched and writes no row.
 */
class SpaceController {
  deleteSpace() {}
  updateSpace() {}
}
class OtherController {
  deleteSpace() {}
}

const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';
const USER_ID = '0198c2a1-0000-7000-8000-000000000001';
const WORKSPACE_ID = '0198c2a1-0000-7000-8000-0000000000aa';

type Req = {
  body?: unknown;
  user?: { user?: { id?: string }; workspace?: { id?: string } };
  headers?: Record<string, string>;
  raw?: { socket?: { remoteAddress?: string }; headers?: Record<string, string> };
};

const authedReq = (body: unknown): Req => ({
  body,
  user: { user: { id: USER_ID }, workspace: { id: WORKSPACE_ID } },
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
  const interceptor = new SpaceHardDeleteInterceptor(mode, client);
  const handler = jest.fn(() => of('handled'));
  const next: CallHandler = { handle: handler };
  return { interceptor, next, handler, forward: fwd };
}

const refusedDelete = (req: Req) => ctx(SpaceController, SpaceController.prototype.deleteSpace, req);

describe('SpaceHardDeleteInterceptor (#502)', () => {
  it('refuses exactly SpaceController.deleteSpace', () => {
    expect([...SPACE_HARD_DELETE_ROUTES]).toEqual(['SpaceController.deleteSpace']);
  });

  describe('AUTHZ_MODE=remote, POST /api/spaces/delete', () => {
    it('404s before the handler and forwards one refusal row with the actor and the attempted space', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete(authedReq({ spaceId: SPACE_ID })), next)),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(handler).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledTimes(1);
      const [events] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(events).toEqual([
        {
          event: SPACE_HARD_DELETE_REFUSED_EVENT,
          resourceType: 'space',
          resourceId: SPACE_ID,
          actorId: USER_ID,
          actorType: 'user',
          workspaceId: WORKSPACE_ID,
          clientEvidence: { socketPeer: '10.0.0.7', forwardedFor: '203.0.113.9' },
          userAgent: 'jest-agent',
          metadata: { outcome: 'denied', reason: 'archive_only', route: 'POST /api/spaces/delete' },
        },
      ]);
      expect(SPACE_HARD_DELETE_REFUSED_EVENT).toBe('space.hard_delete_refused');
    });

    it('never attributes the row to a space through the spaceId column (only the attempted resource)', async () => {
      const { interceptor, next, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete(authedReq({ spaceId: SPACE_ID })), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row).not.toHaveProperty('spaceId');
    });

    it.each([
      ['a slug', { spaceId: 'engineering' }],
      ['a non-string id', { spaceId: { $ne: null } }],
      ['an oversized string', { spaceId: 'x'.repeat(10_000) }],
      ['no spaceId', {}],
      ['a null body', null],
      ['an array body', [SPACE_ID]],
      ['a string body', SPACE_ID],
    ])('404s %s without echoing it into the audit row', async (_label, body) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete(authedReq(body)), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.resourceId).toBeUndefined();
      expect(row.metadata).toEqual({
        outcome: 'denied',
        reason: 'archive_only',
        route: 'POST /api/spaces/delete',
        invalidSpaceId: true,
      });
      expect(JSON.stringify(row)).not.toContain('engineering');
      expect(JSON.stringify(row)).not.toContain('xxxxxxxx');
    });

    it('still 404s, and writes no unattributable row, when there is no authenticated user', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete({ body: { spaceId: SPACE_ID } }), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    });

    it('a failing audit forward never changes the outcome (still 404, no unhandled rejection)', async () => {
      const { interceptor, next, handler } = setup(
        'remote',
        jest.fn().mockRejectedValue(new Error('sink down')),
      );
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete(authedReq({ spaceId: SPACE_ID })), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
    });

    it('a forward that throws synchronously never changes the outcome either', async () => {
      const { interceptor, next, handler } = setup(
        'remote',
        jest.fn(() => {
          throw new Error('boom');
        }),
      );
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete(authedReq({ spaceId: SPACE_ID })), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('everything else passes through with no row', () => {
    it.each([
      ['another handler on SpaceController', ctx(SpaceController, SpaceController.prototype.updateSpace, authedReq({ spaceId: SPACE_ID }))],
      ['a same-named handler on another controller', ctx(OtherController, OtherController.prototype.deleteSpace, authedReq({ spaceId: SPACE_ID }))],
      ['a non-HTTP context', ctx(SpaceController, SpaceController.prototype.deleteSpace, authedReq({ spaceId: SPACE_ID }), 'ws')],
    ])('remote: %s', async (_label, context) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });

    it('native mode: the upstream delete stays reachable (standalone)', async () => {
      const { interceptor, next, handler, forward } = setup('native');
      await expect(
        lastValueFrom(interceptor.intercept(refusedDelete(authedReq({ spaceId: SPACE_ID })), next)),
      ).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });
  });
});
