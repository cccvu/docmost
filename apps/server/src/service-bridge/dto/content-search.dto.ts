import { Transform } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_SEARCH_QUERY_LENGTH } from '../../core/search/dto/search.dto';
import { LABEL_NAME_MAX_LENGTH, LABEL_NAME_PATTERN, toLabelName } from './content-read.dto';

/**
 * Max page size for a content-search call. Mirrors PdpSearchService.MAX_LIMIT (the fork re-clamps limit
 * server-side regardless, so this is a validation nicety — a caller cannot force an unbounded candidate scan).
 */
export const CONTENT_SEARCH_MAX_LIMIT = 100;

/**
 * #615: the shape of a platform principal id — the `service_accounts.id` (or `platform_identities.id`) uuid column.
 * Any-version hex uuid, the same shape Postgres accepts for that column (the platform's Authorization API types it
 * only as a string), so a real service account is never refused for its uuid version or variant.
 */
export const PRINCIPAL_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

  // --- #615 filters: each is a predicate in the candidate SQL, applied BEFORE the authorization windows (a filter
  //     never trims an authorized page afterwards). Ids are Docmost ids (the platform translates identities first).

  /** Restrict to a single Docmost creator id (the platform translates identity → docmost id before calling). */
  @IsOptional()
  @IsUUID()
  creatorId?: string;

  /** #615: restrict to pages whose last editor is this Docmost user id. */
  @IsOptional()
  @IsUUID()
  lastUpdatedById?: string;

  /** #615: restrict to the direct children of this page. */
  @IsOptional()
  @IsUUID()
  parentPageId?: string;

  /** #615: restrict to pages carrying this page label (normalized as Docmost stores label names). */
  @IsOptional()
  @Transform(toLabelName)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LABEL_NAME_MAX_LENGTH)
  @Matches(LABEL_NAME_PATTERN)
  labelName?: string;

  /** #615: updated-at range [since, until). */
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;

  @IsOptional()
  @IsISO8601()
  updatedUntil?: string;

  /**
   * #615: an on-behalf-of credential's SERVICE-ACCOUNT platform principal id (never a Docmost id). When present,
   * every candidate window is gated for `userId` AND this service account, so the page and `hasMore` are computed
   * over service ∩ user. Absent → the user alone (a session, or a credential acting as itself).
   */
  @IsOptional()
  @IsString()
  @Matches(PRINCIPAL_ID_PATTERN)
  serviceSubjectId?: string;

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
