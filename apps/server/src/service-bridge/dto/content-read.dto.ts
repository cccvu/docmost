import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

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
  @IsString()
  updatedAt!: string;

  @IsString()
  id!: string;
}

/**
 * Input for the filter-then-retrieve content list endpoints. `ids` is the PDP-authorized id set the
 * platform computed FIRST (the belt); this endpoint is a privileged data plane that trusts it and does NOT
 * re-authorize. `ids` is capped at 1000 to match the platform's authorized-id cap.
 */
export class ContentListDto {
  @IsArray()
  @ArrayMaxSize(1000)
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
  @Max(100)
  limit!: number;
}
