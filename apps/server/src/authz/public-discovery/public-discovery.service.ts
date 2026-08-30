import { Injectable } from '@nestjs/common';
import { PublicDiscoveryRepo } from './public-discovery.repo';
import { ListPublicPagesDto } from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Orchestrates the anonymous public-content discovery list: clamps the page size, delegates the
 * authorization-filtered query to the repo, and shapes a minimal, PII-free response. It deliberately
 * does NOT catch repo errors — a DB failure propagates to a 500 (fail closed), never a wrong empty 200.
 */
@Injectable()
export class PublicDiscoveryService {
  static readonly DEFAULT_PER_PAGE = 20;
  static readonly MAX_PER_PAGE = 50;

  constructor(private readonly repo: PublicDiscoveryRepo) {}

  async listPublicPages(dto: ListPublicPagesDto, workspaceId: string) {
    const perPage = PublicDiscoveryService.clampPerPage(dto.limit);

    const result = await this.repo.listPublicPages({
      workspaceId,
      perPage,
      cursor: dto.cursor,
    });

    // Minimal, public-safe projection: never leak the share row id, page content, creator, or comments.
    return {
      items: result.items.map((row) => ({
        pageId: row.pageId,
        slugId: row.slugId,
        title: row.title,
        icon: row.icon,
        spaceName: row.spaceName,
        spaceSlug: row.spaceSlug,
        shareKey: row.shareKey,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      meta: {
        hasNextPage: result.meta.hasNextPage,
        nextCursor: result.meta.nextCursor,
      },
    };
  }

  static clampPerPage(limit?: number): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      return PublicDiscoveryService.DEFAULT_PER_PAGE;
    }
    return Math.min(
      Math.max(Math.floor(limit), 1),
      PublicDiscoveryService.MAX_PER_PAGE,
    );
  }
}
