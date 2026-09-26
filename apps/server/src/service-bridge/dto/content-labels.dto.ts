import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CONTENT_LIST_MAX_IDS,
  CONTENT_LIST_MAX_LIMIT,
  LABEL_NAME_MAX_LENGTH,
  toLabelName,
} from './content-read.dto';

/** Keyset position for the label list: the last row's `name` (label names are unique per workspace and type). */
export class ContentLabelCursorDto {
  @IsString()
  @MaxLength(LABEL_NAME_MAX_LENGTH)
  name!: string;
}

/**
 * CCC service-bridge — NOT upstream Docmost code (#615). Input for `POST /api/service/content/labels/list`.
 *
 * `ids` is the platform's PDP-authorized page set (the belt). The fork lists only the labels attached to live pages
 * in that set and counts pages over that set only, so a label that sits only on pages the caller cannot see is never
 * named and a count never reveals a hidden page. Docmost's native `/api/labels` has no such gate.
 */
export class ContentLabelListDto {
  @IsArray()
  @ArrayMaxSize(CONTENT_LIST_MAX_IDS)
  @IsUUID('all', { each: true })
  ids!: string[];

  /** Only labels on pages in this space (and counts over those pages). */
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** Case-insensitive name substring (ilike; %/_ matched literally), normalized as Docmost stores label names. */
  @IsOptional()
  @Transform(toLabelName)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LABEL_NAME_MAX_LENGTH)
  nameContains?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContentLabelCursorDto)
  before?: ContentLabelCursorDto;

  /** Page size; the fork fetches limit+1 so the platform can detect hasMore. */
  @IsInt()
  @Min(1)
  @Max(CONTENT_LIST_MAX_LIMIT)
  limit!: number;
}
