import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { IsExpectedVersion } from '../../service-bridge/resource-version';

/** Page permission role vocabulary (schema: reader → #viewer, writer → #editor). */
export type PageGrantRole = 'reader' | 'writer';

/**
 * #486: the grantee batch cap per id list — the same 256 the platform's `/v1` relay enforces
 * (`services/platform/src/content/acl/acl.dto.ts` MAX_GRANTEES; duplicated because the fork cannot import the
 * platform across the AGPL boundary). Bounds the per-call write set on the native path too.
 */
export const MAX_PAGE_GRANTEES = 256;

export class RestrictPageDto {
  @IsUUID() pageId!: string;
  /**
   * #616: the page ACL version the caller last read (`GET …/permissions` `version`), or `"*"` (the page exists). When
   * sent, it is compared inside the write's transaction under the page's ACL lock — a stale one is a 412
   * `precondition_failed` with nothing changed. Absent = today's behaviour.
   */
  @IsExpectedVersion() expectedVersion?: string;
}

/**
 * #486 (A3): `requireActorCoverage` makes unrestrict refuse unless the actor can edit the page and no direct
 * sub-page would be exposed. The platform relay always sends it (the agent path); the native UI omits it. The
 * flag can only TIGHTEN — omitting it is today's behaviour.
 */
export class RemoveRestrictionDto extends RestrictPageDto {
  @IsOptional() @IsBoolean() requireActorCoverage?: boolean;
}

export class AddPagePermissionDto {
  @IsUUID() pageId!: string;
  @IsIn(['reader', 'writer']) role!: PageGrantRole;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) groupIds?: string[];
  @IsExpectedVersion() expectedVersion?: string;
}

export class RemovePagePermissionDto {
  @IsUUID() pageId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) groupIds?: string[];
  @IsExpectedVersion() expectedVersion?: string;
}

/** Exactly one of `userId` / `groupId` names the grant (enforced in the service — a 400 otherwise). */
export class UpdatePagePermissionDto {
  @IsUUID() pageId!: string;
  @IsIn(['reader', 'writer']) role!: PageGrantRole;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsExpectedVersion() expectedVersion?: string;
}

/** The ACL write a preview runs (and rolls back): the five real routes, by name. */
export const RESTRICTION_PREVIEW_ACTIONS = ['restrict', 'unrestrict', 'add', 'remove', 'update'] as const;
export type RestrictionPreviewAction = (typeof RESTRICTION_PREVIEW_ACTIONS)[number];

/**
 * #616: `POST /api/pages/restriction-preview` — `action` plus exactly the body of the real route it previews
 * (restrict / remove-restriction / add-permission / remove-permission / update-permission), each field validated as
 * that route validates it; a field another action takes is ignored, as the real route's whitelist would drop it.
 * `restriction-preview.dto.spec` pins that every real DTO's fields are accepted here.
 */
export class RestrictionPreviewDto {
  @IsUUID() pageId!: string;
  @IsIn(RESTRICTION_PREVIEW_ACTIONS) action!: RestrictionPreviewAction;
  @IsOptional() @IsIn(['reader', 'writer']) role?: PageGrantRole;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) groupIds?: string[];
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsBoolean() requireActorCoverage?: boolean;
  @IsExpectedVersion() expectedVersion?: string;
}

export class ListPagePermissionsDto {
  @IsUUID() pageId!: string;
  @IsOptional() @IsString() query?: string;
}
