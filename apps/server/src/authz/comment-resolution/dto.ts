import { IsBoolean, IsUUID } from 'class-validator';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * `POST /api/comments/resolve` (#615). The same body the Docmost SPA's resolve button sends (`IResolveComment`
 * in apps/client), so both would land on one route; that button is licence-gated (`comment:resolution`, never
 * granted in this build), so the platform relay is the caller today.
 *
 * Both ids are UUIDs ON PURPOSE: `PageRepo.findById` resolves a non-UUID as a slugId, and a slug would name
 * the page by a second spelling the comment's `pageId` never matches. `resolved` is required and must be a
 * real boolean: the global ValidationPipe transforms without implicit conversion, so `"false"` is refused
 * rather than read as truthy.
 */
export class ResolveCommentDto {
  @IsUUID() commentId!: string;
  @IsUUID() pageId!: string;
  @IsBoolean() resolved!: boolean;
}
