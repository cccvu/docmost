import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
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

  /**
   * #642: the Docmost user the platform validates FOR (the import's acting human). Only an admission key: these
   * conversions take that user's turn at the converter, the same key as their own writes, instead of the shared
   * `background` key. Optional both ways: an older platform omits it (→ `background`), and an older engine's
   * whitelisting ValidationPipe drops it. Never an identity for authorization: nothing is read or written as them.
   */
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  /**
   * #716 I6: the acting human's PLATFORM identity id, which the platform always knows (a human with no Docmost user yet
   * has no `actorUserId`). Same role: only an admission key. Without it such a human's conversions fell to the exempt
   * `background` key and escaped their budget; now they take `identity:<id>`, their own bucket. `actorUserId` wins when
   * both are sent, so a provisioned human keeps their one key. Never an identity for authorization.
   */
  @IsOptional()
  @IsUUID()
  actorIdentityId?: string;
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
