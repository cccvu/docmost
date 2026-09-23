import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Max ids per `pageIds` request and max rows per keyset page; canonical `maximum`s in the PageAuthzStateRequest spec. */
export const PAGE_AUTHZ_STATE_MAX = 500;

/**
 * CCC service-bridge — NOT upstream Docmost code (#545). Input for `POST /api/service/authz/pages/state`.
 *
 * Exactly one mode (the service refuses any mix with a 400):
 *  - `{ pageIds }` — those pages, every id answered (a missing one with `exists: false`);
 *  - `{ subtreeRootId, limit, after? }` — the root's descendants (not the root), keyset on id;
 *  - `{ limit, after? }` — every page (trashed included), keyset on id.
 */
export class PageAuthzStateDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PAGE_AUTHZ_STATE_MAX)
  @IsUUID('all', { each: true })
  pageIds?: string[];

  @IsOptional()
  @IsUUID()
  subtreeRootId?: string;

  @IsOptional()
  @IsUUID()
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE_AUTHZ_STATE_MAX)
  limit?: number;
}
