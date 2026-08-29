import { IsArray, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

/** Page permission role vocabulary (schema: reader → #viewer, writer → #editor). */
export type PageGrantRole = 'reader' | 'writer';

export class RestrictPageDto {
  @IsUUID() pageId!: string;
}

export class AddPagePermissionDto {
  @IsUUID() pageId!: string;
  @IsIn(['reader', 'writer']) role!: PageGrantRole;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) groupIds?: string[];
}

export class RemovePagePermissionDto {
  @IsUUID() pageId!: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) groupIds?: string[];
}

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
