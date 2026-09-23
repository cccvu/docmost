import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsUUID, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

/** Max page size for the trash listing; canonical `maximum` in the TrashListRequest spec. */
export const TRASH_LIST_MAX_LIMIT = 100;

/**
 * CCC service-bridge — NOT upstream Docmost code (#485). Input for `POST /api/service/pages/lifecycle-state`.
 *
 * `targetParentPageId` is tri-state: omitted = no target facts; `null` = the target is the space ROOT; a uuid =
 * that page as the would-be parent.
 */
export class PageLifecycleStateDto {
  @IsUUID()
  pageId!: string;

  @IsOptional()
  @ValidateIf((o: PageLifecycleStateDto) => o.targetParentPageId !== null)
  @IsUUID()
  targetParentPageId?: string | null;
}

/** Keyset position for the trash listing: the last row's `(deletedAt, id)`. */
export class TrashCursorDto {
  @IsISO8601({ strict: true })
  deletedAt!: string;

  @IsUUID()
  id!: string;
}

/** CCC service-bridge — NOT upstream Docmost code (#485). Input for `POST /api/service/pages/trash`. */
export class TrashListDto {
  @IsUUID()
  spaceId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRASH_LIST_MAX_LIMIT)
  limit!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => TrashCursorDto)
  before?: TrashCursorDto;
}
