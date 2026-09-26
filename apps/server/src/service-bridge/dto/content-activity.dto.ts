import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { CONTENT_LIST_MAX_IDS, CONTENT_LIST_MAX_LIMIT } from './content-read.dto';

/**
 * #615: every activity event type the feed serves. The first four are read from the engine's own state tables
 * (`pages`, `page_history`, `comments`, `attachments`); the rest are lifecycle events only Docmost's `audit` table
 * records (`ACTIVITY_AUDIT_TYPES`). Canonical `enum` of ContentActivityListRequest.types and PublicActivityEvent.type.
 */
export const ACTIVITY_TYPES = [
  'page.created',
  'page.updated',
  'comment.created',
  'attachment.uploaded',
  'page.trashed',
  'page.restored',
  'page.moved_to_space',
  'comment.deleted',
  'comment.resolved',
  'comment.reopened',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** The lifecycle events read from Docmost's `audit` table (its `event` column carries exactly these names). */
export const ACTIVITY_AUDIT_TYPES: readonly ActivityType[] = [
  'page.trashed',
  'page.restored',
  'page.moved_to_space',
  'comment.deleted',
  'comment.resolved',
  'comment.reopened',
];

/**
 * An event key: a source letter and the source row's id — `p:` page (created), `h:` page_history (an edit), `c:`
 * comment, `a:` attachment, `e:` audit (lifecycle). Unique across sources, so `(occurredAt, key)` is a total order.
 */
export const ACTIVITY_KEY_PATTERN = /^[pchae]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Keyset position for the activity feed: the last row's `(occurredAt, key)`. */
export class ContentActivityCursorDto {
  @IsISO8601()
  occurredAt!: string;

  @IsString()
  @Matches(ACTIVITY_KEY_PATTERN)
  key!: string;
}

/**
 * CCC service-bridge — NOT upstream Docmost code (#615). Input for `POST /api/service/content/activity/list`.
 *
 * `ids` is the platform's PDP-authorized page set (the belt): every source is pinned to pages in it (and to the
 * workspace), so the feed never names an event on a page the caller cannot see. Window `[since, until)`.
 */
export class ContentActivityListDto {
  @IsArray()
  @ArrayMaxSize(CONTENT_LIST_MAX_IDS)
  @IsUUID('all', { each: true })
  ids!: string[];

  /** Only events on pages CURRENTLY in this space. */
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** Only events on this page. */
  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsISO8601()
  since!: string;

  @IsOptional()
  @IsISO8601()
  until?: string;

  /** Only these event types (absent = all). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ACTIVITY_TYPES.length)
  @IsIn(ACTIVITY_TYPES, { each: true })
  types?: ActivityType[];

  /** Only events by this Docmost user (the platform translates identity → Docmost id before calling). */
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContentActivityCursorDto)
  before?: ContentActivityCursorDto;

  /** Page size; the fork fetches limit+1 so the platform can detect hasMore. */
  @IsInt()
  @Min(1)
  @Max(CONTENT_LIST_MAX_LIMIT)
  limit!: number;
}
