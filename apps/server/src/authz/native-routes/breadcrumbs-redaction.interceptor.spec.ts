import { CallHandler, ExecutionContext, InternalServerErrorException, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { HttpAuthzClient } from '../http-authz.client';
import type { AuthzMode } from '../mode/authz-mode';
import { BreadcrumbsRedactionInterceptor, PAGE_BREADCRUMBS_ROUTES } from './breadcrumbs-redaction.interceptor';

/**
 * BreadcrumbsRedactionInterceptor (#574) — NOT upstream Docmost code.
 *
 * Remote mode: the breadcrumb chain is cut at the first ancestor the caller cannot view (walking `parentPageId` from
 * the requested page, never array order), the topmost kept row's `parentPageId` is nulled when cut, a PDP failure
 * answers `[self]`, a fully viewable chain is returned untouched, `data: []` passes, and any body this cannot fully
 * understand is a 500 rather than an unredacted pass-through. Native mode and other routes are untouched.
 */
class PageController {
  getPageBreadcrumbs() {}
  getPage() {}
}
class OtherController {
  getPageBreadcrumbs() {}
}

const USER_ID = '0198c2a1-0000-7000-8000-000000000001';
const SPACE = '0198c2a1-0000-7000-8000-0000000000cc';
const id = (n: number) => `0198c2a1-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A crumb row exactly as `PageService.getPageBreadCrumbs` selects it. */
const crumb = (n: number, parent: number | null) => ({
  id: id(n),
  slugId: `slug${n}`,
  title: `Title ${n}`,
  icon: null,
  isBase: false,
  position: 'a0',
  parentPageId: parent === null ? null : id(parent),
  spaceId: SPACE,
  deletedAt: null,
  hasChildren: true,
});

/** root(1) → 2 → 3 → self(4), root first as upstream returns it. */
const chain = () => [crumb(1, null), crumb(2, 1), crumb(3, 2), crumb(4, 3)];
const wrap = (data: unknown) => ({ data, success: true, status: 200 });

const ctx = (target: object, handler: unknown, req: object, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    getClass: () => target,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const req = (pageId: unknown = id(4)) => ({ body: { pageId }, user: { user: { id: USER_ID } } });

function setup(mode: AuthzMode, filter: jest.Mock) {
  const authz = { filterResources: filter } as unknown as HttpAuthzClient;
  return new BreadcrumbsRedactionInterceptor(mode, authz);
}

const allow = (...ns: number[]) => jest.fn().mockResolvedValue(ns.map(id));

async function run(
  body: unknown,
  filter: jest.Mock,
  opts: { mode?: AuthzMode; request?: object; target?: object; handler?: unknown; type?: string } = {},
) {
  const interceptor = setup(opts.mode ?? 'remote', filter);
  const next: CallHandler = { handle: () => of(body) };
  return lastValueFrom(
    interceptor.intercept(
      ctx(opts.target ?? PageController, opts.handler ?? PageController.prototype.getPageBreadcrumbs, opts.request ?? req(), opts.type),
      next,
    ),
  );
}

describe('BreadcrumbsRedactionInterceptor (#574)', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('redacts exactly PageController.getPageBreadcrumbs', () => {
    expect([...PAGE_BREADCRUMBS_ROUTES]).toEqual(['PageController.getPageBreadcrumbs']);
  });

  describe('AUTHZ_MODE=remote', () => {
    it('asks the PDP once, for view on the ancestors only, as the docmost user', async () => {
      const filter = allow(1, 2, 3);
      await run(wrap(chain()), filter);
      expect(filter).toHaveBeenCalledTimes(1);
      const [subject, permission, type, ids] = filter.mock.calls[0];
      expect(subject).toEqual({ provider: 'docmost', externalId: USER_ID });
      expect([permission, type]).toEqual(['view', 'page']);
      expect([...ids].sort()).toEqual([id(1), id(2), id(3)]);
    });

    it('a caller who can view the whole chain gets the handler body back untouched (byte-identical)', async () => {
      const body = wrap(chain());
      const before = JSON.stringify(body);
      const out = await run(body, allow(1, 2, 3));
      expect(out).toBe(body);
      expect(JSON.stringify(out)).toBe(before);
    });

    it('parent hidden: answers [self] with its parentPageId withheld', async () => {
      const out = (await run(wrap(chain()), allow(1, 2))) as { data: any[]; success: boolean; status: number };
      expect(out.success).toBe(true);
      expect(out.status).toBe(200);
      expect(out.data).toEqual([{ ...crumb(4, 3), parentPageId: null }]);
    });

    it('mid-chain hidden: keeps only the contiguous run below it, never the viewable root above', async () => {
      // 2 is hidden; 1 is viewable but sits above it, so it must not appear (that would place the hidden page).
      const out = (await run(wrap(chain()), allow(1, 3))) as { data: any[] };
      expect(out.data).toEqual([{ ...crumb(3, 2), parentPageId: null }, crumb(4, 3)]);
      expect(JSON.stringify(out)).not.toContain('Title 2');
      expect(JSON.stringify(out)).not.toContain('Title 1');
      expect(JSON.stringify(out)).not.toContain(id(2));
    });

    it('root hidden: keeps everything below it and nulls the new top', async () => {
      const out = (await run(wrap(chain()), allow(2, 3))) as { data: any[] };
      expect(out.data).toEqual([{ ...crumb(2, 1), parentPageId: null }, crumb(3, 2), crumb(4, 3)]);
    });

    it('walks parentPageId, not array order: a shuffled chain is cut the same way and keeps its order', async () => {
      const shuffled = [crumb(3, 2), crumb(1, null), crumb(4, 3), crumb(2, 1)];
      const out = (await run(wrap(shuffled), allow(1, 3))) as { data: any[] };
      expect(out.data).toEqual([{ ...crumb(3, 2), parentPageId: null }, crumb(4, 3)]);
    });

    it('does not mutate the handler’s rows when it cuts', async () => {
      const rows = chain();
      await run(wrap(rows), allow());
      expect(rows[3].parentPageId).toBe(id(3));
    });

    it.each([
      ['rejects', jest.fn().mockRejectedValue(new Error('pdp down'))],
      ['returns no ids (the client’s own fail-closed answer)', jest.fn().mockResolvedValue([])],
      ['returns a non-array', jest.fn().mockResolvedValue('nope' as unknown)],
    ])('a PDP that %s answers [self]', async (_label, filter) => {
      const out = (await run(wrap(chain()), filter)) as { data: any[] };
      expect(out.data).toEqual([{ ...crumb(4, 3), parentPageId: null }]);
    });

    it('no resolved user: never asks the PDP and answers [self]', async () => {
      const filter = allow(1, 2, 3);
      const out = (await run(wrap(chain()), filter, { request: { body: { pageId: id(4) } } })) as { data: any[] };
      expect(filter).not.toHaveBeenCalled();
      expect(out.data).toEqual([{ ...crumb(4, 3), parentPageId: null }]);
    });

    it('identifies self by slugId when the request named the page by slug', async () => {
      const out = (await run(wrap(chain()), allow(1, 2), { request: req('slug4') })) as { data: any[] };
      expect(out.data).toEqual([{ ...crumb(4, 3), parentPageId: null }]);
    });

    it('a slug that equals another row’s id is never matched against ids (mirrors PageRepo.findById)', async () => {
      const rows = chain();
      rows[3] = { ...rows[3], slugId: 'abc' };
      // pageId is a UUID → only `id` is compared, so self is still row 4 even if another slugId looked like it.
      rows[1] = { ...rows[1], slugId: id(4) };
      const out = (await run(wrap(rows), allow(1, 2), { request: req(id(4)) })) as { data: any[] };
      expect(out.data.map((r) => r.id)).toEqual([id(4)]);
    });

    it('a chain of one (a root page) passes through without a PDP call', async () => {
      const filter = allow();
      const body = wrap([crumb(4, null)]);
      expect(await run(body, filter)).toBe(body);
      expect(filter).not.toHaveBeenCalled();
    });

    it('data: [] (the requested page is trashed) passes through', async () => {
      const filter = allow();
      const body = wrap([]);
      expect(await run(body, filter)).toBe(body);
      expect(filter).not.toHaveBeenCalled();
    });

    it.each([
      ['a bare array (the response wrapper moved inside)', chain()],
      ['null', null],
      ['a string', 'x'],
      ['data not an array', wrap({ 0: crumb(1, null) })],
      ['a row without a string id', wrap([crumb(1, null), { ...crumb(4, 1), id: 4 }])],
      ['a null row', wrap([crumb(1, null), null])],
      ['self missing (pageId names no row)', wrap(chain().slice(0, 3))],
      ['two rows match self', wrap([...chain(), { ...crumb(5, 3), slugId: 'slug4' }])],
      ['self is not the leaf (a row names it as parent)', wrap([...chain(), crumb(5, 4)])],
      ['a row off the chain', wrap([...chain(), crumb(9, null)])],
      ['duplicate ids', wrap([...chain(), crumb(2, 1)])],
      ['a cycle', wrap([{ ...crumb(1, null), parentPageId: id(4) }, crumb(2, 1), crumb(3, 2), crumb(4, 3)])],
    ])('fails closed (500, PDP never consulted) on %s', async (label, body) => {
      const filter = allow(1, 2, 3);
      const request = label.startsWith('two rows') ? req('slug4') : req();
      await expect(run(body, filter, { request })).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(filter).not.toHaveBeenCalled();
    });

    it.each([
      ['no pageId', { body: {}, user: { user: { id: USER_ID } } }],
      ['a non-string pageId', { body: { pageId: 4 }, user: { user: { id: USER_ID } } }],
      ['no body', { user: { user: { id: USER_ID } } }],
    ])('fails closed on %s in the request', async (_label, request) => {
      await expect(run(wrap(chain()), allow(1, 2, 3), { request })).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('a handler error passes through unchanged', async () => {
      const interceptor = setup('remote', allow());
      const boom = new Error('not found');
      const next: CallHandler = { handle: () => throwError(() => boom) };
      await expect(
        lastValueFrom(interceptor.intercept(ctx(PageController, PageController.prototype.getPageBreadcrumbs, req()), next)),
      ).rejects.toBe(boom);
    });
  });

  describe('everything else is untouched', () => {
    it.each([
      ['native mode', { mode: 'native' as AuthzMode }],
      ['another handler', { handler: PageController.prototype.getPage }],
      ['a same-named handler on another controller', { target: OtherController, handler: OtherController.prototype.getPageBreadcrumbs }],
      ['a non-HTTP context', { type: 'ws' }],
    ])('%s: no PDP call, the body as the handler produced it', async (_label, opts) => {
      const filter = allow();
      const body = wrap(chain());
      expect(await run(body, filter, opts)).toBe(body);
      expect(filter).not.toHaveBeenCalled();
    });
  });
});
