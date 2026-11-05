import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { HttpAuthzClient } from '../http-authz.client';
import type { AuthzMode } from '../mode/authz-mode';
import { AUTHZ_UNAVAILABLE_MESSAGE } from '../authz-unavailable';
import { SHARE_PUBLISH_ROUTES, SharePublishInterceptor } from './share-publish.interceptor';
import { SHARE_NOT_PERMITTED_MESSAGE, SHARE_PUBLISH_PERMISSION, SharePublishGate } from './share-publish.gate';

/**
 * SharePublishInterceptor + SharePublishGate (wiki-v2 #704) — NOT upstream Docmost code.
 *
 * Remote mode: share create / update need `page#share` (asked with `page#edit`) on the page the HANDLER would act on,
 * resolved the way the handler resolves it; a raw body the DTO would refuse is a 400 with no PDP call; an unresolved
 * target is the handler's own 404 thrown here (never a pass-through to an ungated handler); an unknown answer is a
 * 503; edit without share is a 403 `share_not_permitted`; everything else reaches the handler unchanged. Native mode,
 * other routes (share delete among them) and non-HTTP contexts are untouched. The expiry route's call is in
 * share-lifecycle.pg.spec.ts.
 */
class ShareController {
  create() {}
  update() {}
  delete() {}
  getShareForPage() {}
}
class OtherController {
  create() {}
}

const USER = '0198c2a1-0000-7000-8000-000000000001';
const WS = '0198c2a1-0000-7000-8000-0000000000aa';
const FOREIGN_WS = '0198c2a1-0000-7000-8000-0000000000bb';
const PAGE = '0198c2a1-0000-7000-8000-000000000101';
const OTHER_PAGE = '0198c2a1-0000-7000-8000-000000000102';
const FOREIGN_PAGE = '0198c2a1-0000-7000-8000-000000000103';
const SHARE = '0198c2a1-0000-7000-8000-000000000201';
const FOREIGN_SHARE = '0198c2a1-0000-7000-8000-000000000202';

const PAGES: Record<string, { id: string; workspaceId: string }> = {
  [PAGE]: { id: PAGE, workspaceId: WS },
  'slug-page': { id: PAGE, workspaceId: WS },
  [OTHER_PAGE]: { id: OTHER_PAGE, workspaceId: WS },
  [FOREIGN_PAGE]: { id: FOREIGN_PAGE, workspaceId: FOREIGN_WS },
};
// What the injected ShareRepo token resolves: PdpShareRepo answers undefined for an expired share, so it is absent.
const SHARES: Record<string, { id: string; pageId: string | null; workspaceId: string }> = {
  [SHARE]: { id: SHARE, pageId: PAGE, workspaceId: WS },
  [FOREIGN_SHARE]: { id: FOREIGN_SHARE, pageId: FOREIGN_PAGE, workspaceId: FOREIGN_WS },
  'share-on-foreign-page': { id: 'share-on-foreign-page', pageId: FOREIGN_PAGE, workspaceId: WS },
  'share-no-page': { id: 'share-no-page', pageId: null, workspaceId: WS },
};

const ctx = (target: object, handler: unknown, req: object, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    getClass: () => target,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const req = (body: unknown, o: { user?: unknown; rawWs?: string; userWs?: string } = {}) => ({
  body,
  raw: o.rawWs ? { workspace: { id: o.rawWs } } : {},
  user: { user: 'user' in o ? o.user : { id: USER }, workspace: { id: o.userWs ?? WS } },
});

/** `decide(pageId)` → the PDP's `[edit, share]`, or null for "could not answer". */
function setup(mode: AuthzMode, decide: (pageId: string) => [boolean, boolean] | null) {
  const tryCheckBulk = jest.fn(async (_s: unknown, checks: Array<{ resourceId: string }>) => decide(checks[0].resourceId));
  const pageRepo = { findById: jest.fn(async (id: string) => PAGES[id]) };
  const shareRepo = { findById: jest.fn(async (id: string) => SHARES[id]) };
  const gate = new SharePublishGate(mode, { tryCheckBulk } as unknown as HttpAuthzClient);
  const interceptor = new SharePublishInterceptor(mode, gate, pageRepo as never, shareRepo as never);
  const handled = jest.fn(() => of('handler-result'));
  const next: CallHandler = { handle: handled };
  const run = (handler: unknown, r: object, target: object = ShareController, type = 'http') =>
    lastValueFrom(interceptor.intercept(ctx(target, handler, r, type), next)) as Promise<any>;
  return { run, tryCheckBulk, pageRepo, shareRepo, handled };
}

const P = ShareController.prototype;
const editOnly = (): [boolean, boolean] => [true, false];
const publisher = (): [boolean, boolean] => [true, true];

describe('SharePublishInterceptor — keys', () => {
  it('gates exactly share create (by pageId) and share update (by shareId)', () => {
    expect([...SHARE_PUBLISH_ROUTES.entries()]).toEqual([
      ['ShareController.create', 'pageId'],
      ['ShareController.update', 'shareId'],
    ]);
  });
});

describe('SharePublishInterceptor — pass-through', () => {
  it('native mode: no PDP call, no lookup, the handler runs even for an edit-only caller', async () => {
    const h = setup('native', editOnly);
    await expect(h.run(P.create, req({ pageId: PAGE }))).resolves.toBe('handler-result');
    await expect(h.run(P.update, req({ shareId: SHARE }))).resolves.toBe('handler-result');
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
    expect(h.pageRepo.findById).not.toHaveBeenCalled();
  });

  it('share delete stays edit-only (narrowing); other routes, controllers and non-HTTP contexts are untouched', async () => {
    const h = setup('remote', editOnly);
    await expect(h.run(P.delete, req({ shareId: SHARE }))).resolves.toBe('handler-result');
    await expect(h.run(P.getShareForPage, req({ pageId: PAGE }))).resolves.toBe('handler-result');
    await expect(h.run(OtherController.prototype.create, req({ pageId: PAGE }), OtherController)).resolves.toBe(
      'handler-result',
    );
    await expect(h.run(P.create, req({ pageId: PAGE }), ShareController, 'ws')).resolves.toBe('handler-result');
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
  });
});

describe('SharePublishInterceptor — raw body fails closed (400, no PDP call)', () => {
  it.each([
    ['no body', undefined],
    ['an array body', [PAGE]],
    ['missing', {}],
    ['empty', { pageId: '' }],
    ['a number', { pageId: 7 }],
    ['an object', { pageId: { id: PAGE } }],
    ['an array', { pageId: [PAGE] }],
  ] as Array<[string, unknown]>)('create with %s pageId → 400', async (_n, body) => {
    const h = setup('remote', publisher);
    await expect(h.run(P.create, req(body))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
    expect(h.pageRepo.findById).not.toHaveBeenCalled();
    expect(h.handled).not.toHaveBeenCalled();
  });

  it.each([
    ['missing (a pageId alone is not enough)', { pageId: PAGE }],
    ['empty', { shareId: '' }],
    ['a number', { shareId: 1 }],
    ['null', { shareId: null }],
  ] as Array<[string, unknown]>)('update with %s shareId → 400', async (_n, body) => {
    const h = setup('remote', publisher);
    await expect(h.run(P.update, req(body))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
    expect(h.shareRepo.findById).not.toHaveBeenCalled();
    expect(h.handled).not.toHaveBeenCalled();
  });

  it('no authenticated user → 401, no PDP call', async () => {
    const h = setup('remote', publisher);
    await expect(h.run(P.create, req({ pageId: PAGE }, { user: undefined }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
  });
});

describe('SharePublishInterceptor — resolution (the handler’s own 404, no PDP call, no handler)', () => {
  it.each([
    ['an unknown page', 'nope'],
    ['a page in another workspace', FOREIGN_PAGE],
  ])('create on %s → 404 Page not found', async (_n, pageId) => {
    const h = setup('remote', publisher);
    const err = await h.run(P.create, req({ pageId })).catch((e: any) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Page not found');
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
    expect(h.handled).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown or expired share (the ShareRepo veto)', 'expired-or-unknown'],
    ['a share in another workspace', FOREIGN_SHARE],
    ['a share with no page', 'share-no-page'],
  ])('update on %s → 404 Share not found', async (_n, shareId) => {
    const h = setup('remote', publisher);
    const err = await h.run(P.update, req({ shareId })).catch((e: any) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Share not found');
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
    expect(h.handled).not.toHaveBeenCalled();
  });

  it('update on a share whose page is in another workspace → 404 Page not found', async () => {
    const h = setup('remote', publisher);
    const err = await h.run(P.update, req({ shareId: 'share-on-foreign-page' })).catch((e: any) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(h.tryCheckBulk).not.toHaveBeenCalled();
  });

  it('reads the workspace as @AuthWorkspace does: req.raw.workspace wins over req.user.workspace', async () => {
    const h = setup('remote', publisher);
    // The JWT's workspace matches, but the request's (domain) workspace does not: 404.
    await expect(h.run(P.create, req({ pageId: PAGE }, { rawWs: FOREIGN_WS }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // And the other way round: the domain workspace is the page's.
    await expect(h.run(P.create, req({ pageId: FOREIGN_PAGE }, { rawWs: FOREIGN_WS, userWs: WS }))).resolves.toBe(
      'handler-result',
    );
  });

  it('create by slug asks the PDP about the resolved uuid, never the raw input', async () => {
    const h = setup('remote', publisher);
    await expect(h.run(P.create, req({ pageId: 'slug-page' }))).resolves.toBe('handler-result');
    expect(h.pageRepo.findById).toHaveBeenCalledWith('slug-page');
    expect(h.tryCheckBulk).toHaveBeenCalledWith({ provider: 'docmost', externalId: USER }, [
      { permission: 'edit', resourceType: 'page', resourceId: PAGE },
      { permission: SHARE_PUBLISH_PERMISSION, resourceType: 'page', resourceId: PAGE },
    ]);
  });

  it('update decides on the SHARE’s page and ignores the body pageId (confused deputy)', async () => {
    // The share's page lacks share; the page named in the body has it.
    const h = setup('remote', (pageId) => (pageId === PAGE ? [true, false] : [true, true]));
    const err = await h.run(P.update, req({ shareId: SHARE, pageId: OTHER_PAGE, includeSubPages: true })).catch(
      (e: any) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(h.pageRepo.findById).not.toHaveBeenCalledWith(OTHER_PAGE);
    expect(h.tryCheckBulk.mock.calls[0][1].map((c: { resourceId: string }) => c.resourceId)).toEqual([PAGE, PAGE]);
    expect(h.handled).not.toHaveBeenCalled();
  });
});

describe('SharePublishInterceptor — the decision', () => {
  it.each([
    ['create', P.create, { pageId: PAGE }],
    ['update', P.update, { shareId: SHARE }],
  ])('%s: the PDP cannot answer → 503 (retryable), handler never runs', async (_n, handler, body) => {
    const h = setup('remote', () => null);
    const err = await h.run(handler, req(body)).catch((e: any) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe(AUTHZ_UNAVAILABLE_MESSAGE);
    expect(h.handled).not.toHaveBeenCalled();
  });

  it.each([
    ['create', P.create, { pageId: PAGE }],
    ['update', P.update, { shareId: SHARE }],
  ])('%s: edit without share → 403 share_not_permitted with a human message', async (_n, handler, body) => {
    const h = setup('remote', editOnly);
    const err = await h.run(handler, req(body)).catch((e: any) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ message: SHARE_NOT_PERMITTED_MESSAGE, code: 'share_not_permitted' });
    expect(h.handled).not.toHaveBeenCalled();
  });

  it.each([
    ['no edit (the handler answers its own 403)', [false, false]],
    ['no edit, a stray share', [false, true]],
    ['edit and share', [true, true]],
  ])('%s → the handler runs', async (_n, answer) => {
    const h = setup('remote', () => answer as [boolean, boolean]);
    await expect(h.run(P.create, req({ pageId: PAGE }))).resolves.toBe('handler-result');
    await expect(h.run(P.update, req({ shareId: SHARE }))).resolves.toBe('handler-result');
    expect(h.handled).toHaveBeenCalledTimes(2);
  });
});

describe('SharePublishGate', () => {
  const gate = (mode: AuthzMode, results: unknown) => {
    const tryCheckBulk = jest.fn().mockResolvedValue(results);
    return { gate: new SharePublishGate(mode, { tryCheckBulk } as unknown as HttpAuthzClient), tryCheckBulk };
  };

  it('native: resolves without asking', async () => {
    const g = gate('native', [true, false]);
    await expect(g.gate.requirePublish(USER, PAGE)).resolves.toBeUndefined();
    expect(g.tryCheckBulk).not.toHaveBeenCalled();
  });

  it('a short answer is "unknown" (503), never an allow', async () => {
    await expect(gate('remote', [true]).gate.requirePublish(USER, PAGE)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(gate('remote', []).gate.requirePublish(USER, PAGE)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
