import { join } from 'path';
import { ExecutionContext } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of } from 'rxjs';

// The interceptor takes CollaborationGateway as a constructor TYPE, but Nest emits its runtime require for DI metadata,
// which pulls in the collab WebSocket stack. Stub it (and the module), as comment-resolution.module.spec.ts does.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));
jest.mock('../../collaboration/collaboration.module', () => ({ CollaborationModule: class CollaborationModule {} }));

import { scanRoutes } from '../route-guard/static-route-scan';
import { CollabQuiescedException } from '../collab-ingress/collab-quiesce';
import { CommentResolutionModule } from './comment-resolution.module';
import { INLINE_COMMENT_CREATE_ROUTE, InlineCommentQuiesceInterceptor } from './inline-comment-quiesce.interceptor';

/**
 * wiki-v2 #919: while collab is quiesced, an inline comment create (it carries `yjsSelection`) is refused 503 before
 * the handler, so no comment row is written; a page comment, and every comment outside a quiesce, goes through.
 */
const ctx = (controller: string, handler: string, body: unknown): ExecutionContext =>
  ({
    getType: () => 'http',
    getClass: () => ({ name: controller }),
    getHandler: () => ({ name: handler }),
    switchToHttp: () => ({ getRequest: () => ({ body }) }),
  }) as never;

const SELECTION = { anchor: { type: { client: 1, clock: 2 } }, head: { type: { client: 1, clock: 4 } } };

function build(quiesced: boolean) {
  const gateway = { isQuiesced: jest.fn(() => quiesced) };
  const interceptor = new InlineCommentQuiesceInterceptor(gateway as never);
  const handler = jest.fn(() => of('row written'));
  const call = (controller: string, handlerName: string, body: unknown) =>
    lastValueFrom(interceptor.intercept(ctx(controller, handlerName, body), { handle: handler }));
  return { call, handler, gateway };
}

describe('#919 InlineCommentQuiesceInterceptor', () => {
  it('while quiesced: an inline comment create is a 503 and the handler (the row insert) never runs', async () => {
    const t = build(true);
    await expect(t.call('CommentController', 'create', { pageId: 'p', content: '{}', yjsSelection: SELECTION })).rejects.toBeInstanceOf(
      CollabQuiescedException,
    );
    expect(t.handler).not.toHaveBeenCalled();
  });

  it('while quiesced: a page comment (no selection) goes through', async () => {
    const t = build(true);
    await expect(t.call('CommentController', 'create', { pageId: 'p', content: '{}' })).resolves.toBe('row written');
    await expect(t.call('CommentController', 'create', { pageId: 'p', content: '{}', yjsSelection: null })).resolves.toBe('row written');
    expect(t.handler).toHaveBeenCalledTimes(2);
  });

  it('outside a quiesce: an inline comment create goes through', async () => {
    const t = build(false);
    await expect(t.call('CommentController', 'create', { pageId: 'p', content: '{}', yjsSelection: SELECTION })).resolves.toBe('row written');
  });

  it('any other route is untouched, quiesced or not (it never asks the gateway)', async () => {
    const t = build(true);
    await expect(t.call('CommentController', 'update', { yjsSelection: SELECTION })).resolves.toBe('row written');
    await expect(t.call('PageController', 'create', { yjsSelection: SELECTION })).resolves.toBe('row written');
    expect(t.gateway.isQuiesced).not.toHaveBeenCalled();
  });

  it('its key names the real upstream route, the only route that creates a comment (the one that writes the mark)', () => {
    const routes = scanRoutes(join(__dirname, '..', '..'));
    expect(routes.length).toBeGreaterThanOrEqual(80); // a meaningful scan
    const creates = routes.filter((r) => /commentService\.create\s*\(/.test(r.handlerText)).map((r) => `${r.controller}.${r.handler}`);
    expect(creates).toEqual([INLINE_COMMENT_CREATE_ROUTE]);
    const route = routes.find((r) => `${r.controller}.${r.handler}` === INLINE_COMMENT_CREATE_ROUTE)!;
    expect(route.httpPath).toBe('/api/comments/create');
  });

  it('is registered as an APP_INTERCEPTOR by CommentResolutionModule (mounted at the app root)', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CommentResolutionModule) as unknown[];
    expect(providers).toContainEqual({ provide: APP_INTERCEPTOR, useClass: InlineCommentQuiesceInterceptor });
  });
});
