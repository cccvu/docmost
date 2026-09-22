import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

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
}

export class RemovePagePermissionDto {
  @IsUUID() pageId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PAGE_GRANTEES) @IsUUID('all', { each: true }) groupIds?: string[];
}

/** Exactly one of `userId` / `groupId` names the grant (enforced in the service — a 400 otherwise). */
export class UpdatePagePermissionDto {
  @IsUUID() pageId!: string;
  @IsIn(['reader', 'writer']) role!: PageGrantRole;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() groupId?: string;
}

export class ListPagePermissionsDto {
  @IsUUID() pageId!: string;
  @IsOptional() @IsString() query?: string;
}
