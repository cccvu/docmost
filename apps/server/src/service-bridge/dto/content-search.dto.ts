import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_SEARCH_QUERY_LENGTH } from '../../core/search/dto/search.dto';

/**
 * Max page size for a content-search call. Mirrors PdpSearchService.MAX_LIMIT (the fork re-clamps limit
 * server-side regardless, so this is a validation nicety — a caller cannot force an unbounded candidate scan).
 */
export const CONTENT_SEARCH_MAX_LIMIT = 100;

/**
 * CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/content/search`.
 *
 * The platform authenticates the caller and resolves their shadow Docmost user id (`userId`); the fork runs
 * the PDP-gated filter-then-retrieve search (PdpSearchService) AS that user and returns a PII-free hit shape.
 * There is deliberately NO `shareId`: this is the authenticated path (mirroring the native controller, which
 * strips shareId when a user is present), so the per-principal PDP gate always applies.
 */
export class ContentSearchDto {
  /** The searching user's Docmost id (the platform's resolved shadow id). Search runs as this user. */
  @IsUUID()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  query!: string;

  /** Restrict to a single space; omitted → the user's member spaces (the PDP gate is authoritative either way). */
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** Restrict to a single Docmost creator id (the platform translates identity → docmost id before calling). */
  @IsOptional()
  @IsUUID()
  creatorId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CONTENT_SEARCH_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
