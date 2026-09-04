import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
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

/** A keyset cursor position (the platform decodes the opaque /v1 cursor and passes it explicitly). */
export class ContentCursorDto {
  // Bound to `::timestamptz` in the keyset predicate; require an ISO-8601 instant so a malformed cursor is a
  // 400 at validation, not a 500 at the cast. The platform always sends canonical ISO; this guards a direct
  // service-bridge caller.
  @IsISO8601()
  updatedAt!: string;

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
