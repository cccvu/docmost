import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable, mergeMap } from 'rxjs';
import { validate as isValidUUID } from 'uuid';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { authzUnavailable } from '../authz-unavailable';

/** The upstream routes that return a page's ancestor chain (`Controller.handler`). `native-route-authz.fitness.spec.ts`
 *  pins this set to exactly the routes whose handler reaches `.getPageBreadCrumbs(`. */
export const PAGE_BREADCRUMBS_ROUTES: ReadonlySet<string> = new Set(['PageController.getPageBreadcrumbs']);

type AuthedRequest = FastifyRequest & { user?: { user?: { id?: string } } };

/** One breadcrumb row as `PageService.getPageBreadCrumbs` selects it; only the fields this redaction reads are typed. */
interface Crumb {
  id: string;
  slugId?: unknown;
  parentPageId?: unknown;
  [field: string]: unknown;
}

/** The body as the outer interceptors see it: `TransformHttpResponseInterceptor` has already wrapped the handler's array. */
interface WrappedBody {
  data: Crumb[];
  [field: string]: unknown;
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#574).
 *
 * `POST /api/pages/breadcrumbs` checks view on the requested page only, then returns every live ancestor's id,
 * slugId, title and icon. In `AUTHZ_MODE=remote` a grant on a page does not open its restricted ancestors (the
 * schema's `page_grant_view` admits the grantee to that page alone), so a grantee learned the titles of pages they
 * cannot see. This cuts the chain at the first ancestor the caller cannot view, exactly as `/v1 …/ancestors` (#615)
 * does: walk from the requested page up through `parentPageId` and keep the contiguous viewable run, never anything
 * above a hidden page (skipping one would also tell where the hidden page sits). The topmost kept row's
 * `parentPageId` is nulled when the chain is cut, as `/v1 expand=parent` withholds an unreadable parent; that also
 * keeps the client's `buildTreeWithChildren` from dereferencing a parent that is not in the list.
 *
 * Shape. Fork APP_INTERCEPTORs are registered at `NestFactory.create`; `main.ts` appends
 * `TransformHttpResponseInterceptor` afterwards with `useGlobalInterceptors`, so it runs INSIDE this one and the body
 * here is `{ data, success, status }` (pinned by `breadcrumbs-redaction-pipeline.spec.ts`). `data: []` (the requested
 * page is trashed) passes through. Anything else this cannot fully understand is a 500, never an unredacted body.
 *
 * Self. The requested page is the row the controller resolved from the raw `pageId` the same way `PageRepo.findById`
 * does (a UUID matches `id`, anything else `slugId`), and it must also be the chain's leaf: the one row no other row
 * names as its parent. The upstream query starts its recursive walk at exactly that row, so both always hold; if
 * either fails, or the `parentPageId` walk from it does not visit every row exactly once, the body is not a chain
 * this can reason about and the request fails closed. Array order is never trusted (the recursive CTE has no
 * ORDER BY), but the response keeps upstream's order for whatever it keeps.
 *
 * Decision. One `tryFilterResources(view)` over the ancestor ids. A PDP that could not answer (a failed or malformed
 * chunk) is a 503 (`authzUnavailable`, #716), never `[self]`: a chain cut at the requested page reads as "this page
 * has no visible parents", which the client renders as a root page. A rejection from the client (it never rejects, so
 * that is a bug) propagates as the error it is. An empty answer is a real deny and keeps `[self]`. A caller who can
 * view the whole chain gets the handler's body back untouched (the same object), so the response is byte-identical.
 *
 * Registered by the fork-owned `NativeRouteAuthzModule` (no upstream seam). Native mode keeps the upstream response:
 * the stock `canUserAccessPage` already requires access through every restricted ancestor.
 */
@Injectable()
export class BreadcrumbsRedactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(BreadcrumbsRedactionInterceptor.name);

  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly authz: HttpAuthzClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!PAGE_BREADCRUMBS_ROUTES.has(route)) return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return next.handle().pipe(mergeMap((body) => this.redact(body, req)));
  }

  /** The body with every ancestor at or above the first hidden one removed (see the class doc). */
  private async redact(body: unknown, req: AuthedRequest): Promise<unknown> {
    if (!isWrappedBody(body)) throw this.unexpected('body is not { data: Crumb[] }');
    const rows = body.data;
    if (rows.length === 0) return body;

    const chain = this.chainFromSelf(rows, requestedPageId(req));
    const ancestors = chain.slice(1);
    if (ancestors.length === 0) return body;

    const userId = req.user?.user?.id;
    const viewable = typeof userId === 'string' && userId ? await this.viewable(userId, ancestors) : new Set<string>();
    let kept = 1;
    while (kept < chain.length && viewable.has(chain[kept].id)) kept++;
    if (kept === chain.length) return body;

    const keptIds = new Set(chain.slice(0, kept).map((r) => r.id));
    const topId = chain[kept - 1].id;
    return {
      ...body,
      data: rows
        .filter((r) => keptIds.has(r.id))
        .map((r) => (r.id === topId ? { ...r, parentPageId: null } : r)),
    };
  }

  /** The rows ordered self → root by `parentPageId`, after checking they form exactly one chain from self. */
  private chainFromSelf(rows: Crumb[], pageId: string | undefined): Crumb[] {
    if (pageId === undefined) throw this.unexpected('no requested pageId');
    const byUuid = isValidUUID(pageId);
    const matches = rows.filter((r) => (byUuid ? r.id === pageId : r.slugId === pageId));
    if (matches.length !== 1) throw this.unexpected('requested page is not exactly one row');
    const self = matches[0];
    if (rows.some((r) => r.parentPageId === self.id)) throw this.unexpected('requested page is not the leaf');

    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== rows.length) throw this.unexpected('duplicate row ids');
    const chain: Crumb[] = [];
    const seen = new Set<string>();
    for (let cur: Crumb | undefined = self; cur && !seen.has(cur.id); ) {
      seen.add(cur.id);
      chain.push(cur);
      cur = typeof cur.parentPageId === 'string' ? byId.get(cur.parentPageId) : undefined;
    }
    if (chain.length !== rows.length) throw this.unexpected('rows are not one parent chain from the requested page');
    return chain;
  }

  private async viewable(userId: string, ancestors: Crumb[]): Promise<Set<string>> {
    const ids = await this.authz.tryFilterResources(
      { provider: 'docmost', externalId: userId },
      'view',
      'page',
      ancestors.map((r) => r.id),
    );
    if (ids === null) throw authzUnavailable();
    return new Set(ids);
  }

  private unexpected(why: string): InternalServerErrorException {
    // No row content in the log: only why the shape was refused.
    this.logger.error(`breadcrumbs redaction refused the response (${why})`);
    return new InternalServerErrorException();
  }
}

function isWrappedBody(body: unknown): body is WrappedBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const data = (body as { data?: unknown }).data;
  return (
    Array.isArray(data) &&
    data.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && typeof (r as Crumb).id === 'string')
  );
}

/** The raw `pageId` the handler resolved (interceptors see the body before `ValidationPipe`; the handler succeeded,
 *  so it was a non-empty string). */
function requestedPageId(req: AuthedRequest): string | undefined {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const pageId = (body as { pageId?: unknown }).pageId;
  return typeof pageId === 'string' && pageId ? pageId : undefined;
}
