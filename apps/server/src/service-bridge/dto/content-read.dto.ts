import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Max authorized ids the platform may forward in one content-list call. This MUST stay >= the platform's
 * `content.maxListAuthorizedIds` default (10000) or a principal authorized on more objects than the fork
 * accepts gets a 400 on `/v1` lists (a regression of the shipped endpoint). It is also the canonical
 * `maxItems` in `service-bridge.openapi.json#/components/schemas/ContentListRequest`; the provider contract
 * test (`service-bridge.contract.spec.ts`) fails the build if the three drift apart.
 */
export const CONTENT_LIST_MAX_IDS = 10000;

/** Max page size for a content-list call; canonical `maximum` in the ContentListRequest spec (guarded by the contract test). */
export const CONTENT_LIST_MAX_LIMIT = 100;

/** CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/pages/resolve-space`. */
export class ResolvePageSpaceDto {
  @IsUUID()
  pageId!: string;

  /** When true, resolve even a soft-deleted page's space (the platform's pageToSpaceAnyState variant). */
  @IsOptional()
  @IsBoolean()
  includeDeleted?: boolean;
}

/** The allowlisted content sort fields. `title` is pages-only, `name` is spaces-only (the service rejects a
 *  cross-resource field); `updatedAt`/`createdAt` apply to both. Each is always tie-broken by `id`. */
export const CONTENT_SORT_FIELDS = ['updatedAt', 'createdAt', 'title', 'name'] as const;
export type ContentSortField = (typeof CONTENT_SORT_FIELDS)[number];

/** An allowlisted sort key + direction. Absent → the legacy default (`updatedAt desc`, id-tiebroken). */
export class ContentSortDto {
  @IsIn(CONTENT_SORT_FIELDS)
  field!: ContentSortField;

  @IsIn(['asc', 'desc'])
  direction!: 'asc' | 'desc';
}

/**
 * A keyset cursor position (the platform decodes the opaque /v1 cursor and passes it explicitly).
 *
 * Two shapes, both decoded by the platform:
 *  - Legacy (`updatedAt` set): the default `updatedAt desc` sort — bound to `::timestamptz` in the predicate.
 *  - Generalized (`value` set): the bound for the ACTIVE sort field — a `::timestamptz` for updatedAt/createdAt
 *    or the `coalesce(title|name,'')` string for a text sort. `updatedAt` is optional so a text-sort cursor
 *    (no timestamp bound) still validates.
 */
export class ContentCursorDto {
  // Bound to `::timestamptz` on the default/timestamp-sort path; require an ISO-8601 instant so a malformed
  // cursor is a 400 at validation, not a 500 at the cast. The platform always sends canonical ISO.
  @IsOptional()
  @IsISO8601()
  updatedAt?: string;

  /** The generic sort-key bound for cursor-v2 (any allowlisted sort field). Opaque string; cast in the query. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  value?: string;

  @IsString()
  id!: string;
}

/**
 * Input for the filter-then-retrieve content list endpoints. `ids` is the PDP-authorized id set the
 * platform computed FIRST (the belt); this endpoint is a privileged data plane that trusts it and does NOT
 * re-authorize. `ids` is capped at CONTENT_LIST_MAX_IDS, which MUST stay >= the platform's authorized-id cap
 * (see that constant); the caps are kept in sync by the provider/consumer contract tests.
 */
export class ContentListDto {
  @IsArray()
  @ArrayMaxSize(CONTENT_LIST_MAX_IDS)
  @IsUUID('all', { each: true })
  ids!: string[];

  /** Pages only: scope the list to a single space. */
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  // --- Allowlisted filters (pushed into the keyset SQL; each method applies only its own resource's subset).
  //     The platform translates creatorId identity→docmost id BEFORE calling (it never crosses as a platform id).

  /** Pages only: children of this parent (a top-level-only filter would use a sentinel the platform sets). */
  @IsOptional()
  @IsUUID()
  parentPageId?: string;

  /** Pages only: case-insensitive title substring (ilike; %/_ are matched literally). */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  titleContains?: string;

  /** Pages only: the page's Docmost creator id. */
  @IsOptional()
  @IsUUID()
  creatorId?: string;

  /** Spaces only: case-insensitive name substring (ilike; %/_ are matched literally). */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameContains?: string;

  /** Pages + spaces: updated-at range [since, until). */
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;

  @IsOptional()
  @IsISO8601()
  updatedUntil?: string;

  /** Spaces only: created-at range [since, until). */
  @IsOptional()
  @IsISO8601()
  createdSince?: string;

  @IsOptional()
  @IsISO8601()
  createdUntil?: string;

  /** Sort key + direction (allowlisted). Absent → the legacy `updatedAt desc` default. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ContentSortDto)
  sort?: ContentSortDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContentCursorDto)
  before?: ContentCursorDto;

  /** Page size; the fork fetches limit+1 so the platform can detect hasMore. */
  @IsInt()
  @Min(1)
  @Max(CONTENT_LIST_MAX_LIMIT)
  limit!: number;
}
