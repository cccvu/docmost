import { Transform, TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EXTERNAL_ID } from './space-admin.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #797). DTOs for the group control plane the platform calls
 * (it authorizes the workspace admin FIRST; these carry no authorization policy).
 *
 * Members are named ONLY by integrator identity externalIds: no DTO here has a group-id member field, and the fork
 * resolves each externalId to a shadow USER (`group_users.user_id` references `users`), so a group can never be made a
 * member of a group (no nested groups, no `group#member` subject relation in the projection). The whitelisting
 * ValidationPipe strips any other key.
 */

/** Group-name bounds after trimming (the platform contract: 1..100; upstream's own maximum is 100). */
export const GROUP_NAME_MIN_LENGTH = 1;
export const GROUP_NAME_MAX_LENGTH = 100;
export const GROUP_DESCRIPTION_MAX_LENGTH = 500;
/** The most identities one member add, ensure or membership lookup names. */
export const GROUP_MEMBER_BATCH_MAX = 200;

const trim = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

function ActorExternalId(): PropertyDecorator {
  return (target: object, key: string | symbol) => {
    IsString()(target, key);
    Matches(EXTERNAL_ID, { message: 'actorExternalId must be 1-128 chars of [A-Za-z0-9._+-]' })(target, key);
  };
}

function ExternalIdList(min: number): PropertyDecorator {
  return (target: object, key: string | symbol) => {
    IsArray()(target, key);
    ArrayMinSize(min)(target, key);
    ArrayMaxSize(GROUP_MEMBER_BATCH_MAX)(target, key);
    IsString({ each: true })(target, key);
    Matches(EXTERNAL_ID, { each: true, message: 'each externalId must be 1-128 chars of [A-Za-z0-9._+-]' })(target, key);
  };
}

export class CreateGroupDto {
  @Transform(trim)
  @IsString()
  @MinLength(GROUP_NAME_MIN_LENGTH)
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(GROUP_DESCRIPTION_MAX_LENGTH)
  description?: string;

  /** The acting human's externalId (the group's `creator_id`; provisioned like any shadow user). */
  @ActorExternalId()
  actorExternalId!: string;
}

export class UpdateGroupDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(GROUP_NAME_MIN_LENGTH)
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name?: string;

  /** An empty string clears the description. */
  @IsOptional()
  @IsString()
  @MaxLength(GROUP_DESCRIPTION_MAX_LENGTH)
  description?: string;

  /** The acting human's externalId (required; carried for the integrator's audit parity, never a Docmost id). */
  @ActorExternalId()
  actorExternalId!: string;
}

/** `POST service/groups/:groupId/members` — 1..200 identities, by externalId only. */
export class AddGroupMembersDto {
  @ExternalIdList(1)
  externalIds!: string[];

  /** The acting human's externalId (required). */
  @ActorExternalId()
  actorExternalId!: string;
}

/** `POST service/groups/memberships/lookup` — the live groups one identity is in (a read). */
export class GroupMembershipLookupDto {
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  externalId!: string;
}

/**
 * `POST service/groups/default/ensure` — name the default group with the integrator's neutral text and make sure each
 * of 0..200 identities is in it. The text is the integrator's (the fork carries no brand strings).
 */
export class EnsureDefaultGroupDto {
  @Transform(trim)
  @IsString()
  @MinLength(GROUP_NAME_MIN_LENGTH)
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(GROUP_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @ExternalIdList(0)
  externalIds!: string[];
}
