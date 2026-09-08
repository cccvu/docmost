import { Injectable } from '@nestjs/common';
import { SearchService } from '../core/search/search.service';
import { SearchDTO } from '../core/search/dto/search.dto';
import { SearchResponseDto } from '../core/search/dto/search-response.dto';
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
 */
@Injectable()
export class ServiceSearchService {
  constructor(
    private readonly search: SearchService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  async searchContent(dto: ContentSearchDto): Promise<{ items: PublicSearchHit[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    // Exactly the authenticated-path fields — NEVER shareId (the native controller deletes it when a user is
    // present; the fork's PdpSearchService applies the per-principal gate only on the userId path).
    const searchParams = {
      query: dto.query,
      spaceId: dto.spaceId,
      creatorId: dto.creatorId,
      limit: dto.limit,
      offset: dto.offset,
    } as SearchDTO;
    const { items } = await this.search.searchPage(searchParams, {
      userId: dto.userId,
      workspaceId,
    });
    return { items: items.map(toSearchHit) };
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
