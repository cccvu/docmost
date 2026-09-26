import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SearchService } from '../core/search/search.service';
import { SearchDTO } from '../core/search/dto/search.dto';
import { SearchResponseDto } from '../core/search/dto/search-response.dto';
import { PdpSearchService } from '../authz/search/pdp-search.service';
import { WorkspaceResolver } from './workspace-resolver';
import { ContentSearchDto } from './dto/content-search.dto';

/**
 * A single permission-aware search hit, projected PII-free for `/v1`. It DELIBERATELY drops the raw
 * SearchResponseDto's `creatorId` (an ADR-0001 Docmost-user-id leak), `rank` (no ranking side-channel;
 * ADR-0005), and `slugId` (not part of the public hit shape). Timestamps are ISO strings over the wire,
 * matching the rest of the service-bridge read model.
 */
export interface PublicSearchHit {
  id: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  space: { id: string; name: string | null; slug: string } | null;
  highlight: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The `searchContent` answer (#615, contract 1.8.0): one authorized page of hits + whether more follow. */
export interface ContentSearchResult {
  items: PublicSearchHit[];
  hasMore: boolean;
}

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Exposes the fork's PDP-gated content search (PdpSearchService, bound to the SearchService token in
 * AUTHZ_MODE=remote via seam #5 — see UPSTREAM_MODIFICATIONS.md) as an east-west op. Unlike
 * ServiceContentService — a privileged data plane over an already-authorized id set — search IS the
 * authorization gate: PdpSearchService walks the rank-ordered FTS candidates in bounded windows and admits
 * ONLY the caller's authorized pages BEFORE the limit/offset slice (filter-then-retrieve; ADR-0005). The
 * platform therefore MUST NOT intersect the result with a separately-computed authorized-id set — that would
 * reintroduce the reverse-index truncation the subclass exists to avoid. It passes the caller's Docmost user
 * id and projects the PII-free shape. This is a SEPARATE provider from ServiceContentService precisely so the
 * content read model keeps its structural "no authorization collaborator" invariant.
 *
 * #615: the filters, the `hasMore` peek and the on-behalf-of service leg exist only on PdpSearchService
 * (`searchAuthorized`), so the injected SearchService is narrowed to it at call time. The token resolves to the
 * stock upstream SearchService in AUTHZ_MODE=native (and this bridge is remote-only anyway); anything but the PDP
 * subclass answers 503 rather than run a search without the filter-then-retrieve gate.
 */
@Injectable()
export class ServiceSearchService {
  private readonly logger = new Logger(ServiceSearchService.name);

  constructor(
    private readonly search: SearchService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  async searchContent(dto: ContentSearchDto): Promise<ContentSearchResult> {
    const search = this.pdpSearch();
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    // Exactly the authenticated-path fields — NEVER shareId (the native controller deletes it when a user is
    // present; the fork's PdpSearchService applies the per-principal gate only on the userId path). Every
    // narrowing is a candidate filter (below), never a post-filter of the page.
    const searchParams = {
      query: dto.query,
      spaceId: dto.spaceId,
      limit: dto.limit,
      offset: dto.offset,
    } as SearchDTO;
    const { items, hasMore } = await search.searchAuthorized(
      searchParams,
      {
        creatorId: dto.creatorId,
        lastUpdatedById: dto.lastUpdatedById,
        parentPageId: dto.parentPageId,
        labelName: dto.labelName,
        updatedSince: dto.updatedSince,
        updatedUntil: dto.updatedUntil,
      },
      { userId: dto.userId, workspaceId, serviceSubjectId: dto.serviceSubjectId },
    );
    return { items: items.map(toSearchHit), hasMore: hasMore === true };
  }

  /** The injected search, narrowed to the PDP subclass (the only one with `searchAuthorized`); else 503. */
  private pdpSearch(): PdpSearchService {
    if (this.search instanceof PdpSearchService) return this.search;
    this.logger.error(
      'content search needs the PDP-gated search (AUTHZ_MODE=remote); the SearchService token resolved to another class',
    );
    throw new ServiceUnavailableException('content search is not available');
  }
}

function toSearchHit(r: SearchResponseDto): PublicSearchHit {
  const space = (r.space ?? null) as { id: string; name: string | null; slug: string } | null;
  return {
    id: r.id,
    title: r.title ?? null,
    icon: r.icon ?? null,
    parentPageId: (r.parentPageId as string | null) ?? null,
    space: space ? { id: space.id, name: space.name ?? null, slug: space.slug } : null,
    highlight: r.highlight ?? null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}
