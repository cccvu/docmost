import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** The two page-edit modes Docmost recognises (anything else normalises to null in the view). */
export const PAGE_EDIT_MODES = ['read', 'edit'] as const;
export type PageEditMode = (typeof PAGE_EDIT_MODES)[number];

/**
 * CCC service-bridge — NOT upstream Docmost code. Input for `PATCH /api/service/workspace/settings`.
 * Every field optional (partial update); an empty body returns the current settings unchanged.
 */
export class UpdateWorkspaceSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsIn(PAGE_EDIT_MODES)
  defaultPageEditMode?: PageEditMode;
}
