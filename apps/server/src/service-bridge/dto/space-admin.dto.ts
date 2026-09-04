import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * CCC service-bridge — NOT upstream Docmost code. DTOs for the space/membership control plane the platform
 * calls (it authorizes `space#administer` FIRST; these carry no policy). Roles are Docmost's native
 * per-space roles projected into SpiceDB as `space:<id>#{admin,writer,reader}`.
 */
export const SPACE_ROLES = ['admin', 'writer', 'reader'] as const;
export type SpaceMemberRole = (typeof SPACE_ROLES)[number];

const EXTERNAL_ID = /^[A-Za-z0-9._+-]{1,128}$/;

export class CreateSpaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Optional explicit slug; when absent the fork derives one from the name. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /**
   * The acting platform identity's opaque externalId — the fork resolves it to the creator's shadow user
   * (the creator FK + the initial `admin` member). Never a Docmost user id.
   */
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'creatorExternalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  creatorExternalId!: string;
}

export class UpdateSpaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class AddSpaceMemberDto {
  /** The platform identity to add, as its opaque externalId — resolved to a shadow user server-side. */
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  externalId!: string;

  @IsIn(SPACE_ROLES)
  role!: SpaceMemberRole;

  /** The acting admin's externalId (the `added_by` FK). */
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'addedByExternalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  addedByExternalId!: string;
}

export class UpdateSpaceMemberDto {
  @IsIn(SPACE_ROLES)
  role!: SpaceMemberRole;
}
