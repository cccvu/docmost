import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * CCC service-bridge — NOT upstream Docmost code (#616). Inputs of the page-import helpers
 * (`POST /api/service/pages/validate-content`, `POST /api/service/pages/title-candidates`). The bounds are canonical
 * here and mirrored in `service-bridge.openapi.json` (the provider contract spec fails the build if they drift).
 */

/** Items (validate-content) and titles (title-candidates) per call — an import's own item cap. */
export const PAGE_IMPORT_MAX_ITEMS = 50;
/** One item's content, in UTF-8 bytes. Larger → that item is `too_large` (a per-item answer, not a 400). */
export const PAGE_IMPORT_ITEM_MAX_BYTES = 512 * 1024;
/** All parsed content in one call, in UTF-8 bytes. Past it → that item and every later one are `too_large`. */
export const PAGE_IMPORT_TOTAL_MAX_BYTES = 1024 * 1024;
/** A page title, as the import takes it. */
export const PAGE_IMPORT_TITLE_MAX_LENGTH = 255;
export const PAGE_IMPORT_FORMATS = ['markdown', 'html'] as const;
export type PageImportFormat = (typeof PAGE_IMPORT_FORMATS)[number];

export class ValidateContentItemDto {
  @IsIn(PAGE_IMPORT_FORMATS)
  format!: PageImportFormat;

  /** Unbounded HERE on purpose: an oversized item is answered per item (`too_large`); the body limit bounds the call. */
  @IsString()
  content!: string;
}

export class ValidateContentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PAGE_IMPORT_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => ValidateContentItemDto)
  items!: ValidateContentItemDto[];
}

export class TitleCandidatesDto {
  @IsUUID()
  spaceId!: string;

  /** The parent whose live direct children are compared; omitted or `null` = the space's root level. */
  @ValidateIf((o: TitleCandidatesDto) => o.parentPageId !== undefined && o.parentPageId !== null)
  @IsUUID()
  parentPageId?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PAGE_IMPORT_MAX_ITEMS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(PAGE_IMPORT_TITLE_MAX_LENGTH, { each: true })
  titles!: string[];
}
