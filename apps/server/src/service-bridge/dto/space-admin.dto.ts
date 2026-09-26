import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsExpectedVersion } from '../resource-version';
import {
  IsIdempotencyKey,
  IsIdempotencyNamespace,
  IsRequestFingerprint,
} from '../../authz/idempotency/idempotency-dto';

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

  /**
   * #616: an optional KEYED create — all three fields or none (one without the others is a 400). A keyed create is
   * recorded in the fork's idempotency ledger in the space insert's own transaction, bound to the workspace, the
   * authenticating service credential, the creator (the acting human) and `idempotencyNamespace`: a repeat answers the
   * space it created with `replayed: true`, the same key with a different `fingerprint` is a 409
   * `idempotency_key_reused`. Omitted → the unkeyed create, unchanged.
   */
  @ValidateIf(isKeyedCreate)
  @IsIdempotencyKey()
  idempotencyKey?: string;

  /** #616: the integrator's opaque key namespace (1–128). Required with `idempotencyKey`. */
  @ValidateIf(isKeyedCreate)
  @IsIdempotencyNamespace()
  idempotencyNamespace?: string;

  /** #616: sha256 hex (64 lowercase) of the integrator's stable request body. Required with `idempotencyKey`. */
  @ValidateIf(isKeyedCreate)
  @IsRequestFingerprint()
  fingerprint?: string;
}

/** A create that sends ANY of the three keyed fields must send all three (each is then validated as required). */
function isKeyedCreate(o: CreateSpaceDto): boolean {
  return o.idempotencyKey !== undefined || o.idempotencyNamespace !== undefined || o.fingerprint !== undefined;
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

  /** #616: the space's version (its `GET` `version`), or `"*"`; compared under the space row lock (412 if stale). */
  @IsExpectedVersion()
  expectedVersion?: string;
}

/** #616: the optional body of archive and member removal — only the version to compare. */
export class ExpectedVersionDto {
  @IsExpectedVersion()
  expectedVersion?: string;
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

  /**
   * The acting identity's externalId (#486, rule M) — REQUIRED, so a caller that omits it is refused (400)
   * rather than skipping the self-raise check. Compared against the member row, never written.
   */
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'actorExternalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  actorExternalId!: string;

  /** #616: the membership's version (its list item `version`), or `"*"`; compared under the row lock. */
  @IsExpectedVersion()
  expectedVersion?: string;
}

export const SPACE_MEMBER_PREVIEW_ACTIONS = ['add', 'update', 'remove'] as const;
export type SpaceMemberPreviewAction = (typeof SPACE_MEMBER_PREVIEW_ACTIONS)[number];

/**
 * #616: `POST service/spaces/:spaceId/members/preview` — `action` plus the body of the real write it previews:
 *   add    → `externalId`, `role`, `addedByExternalId`            (as `POST …/members`)
 *   update → `memberId`, `role`, `actorExternalId`, `expectedVersion?` (as `PATCH …/members/:memberId`)
 *   remove → `memberId`, `expectedVersion?`                        (as `DELETE …/members/:memberId`)
 * Each field is validated as the real route validates it; a field the action does not take is ignored, and one it
 * requires but lacks is a 400.
 */
export class SpaceMemberPreviewDto {
  @IsIn(SPACE_MEMBER_PREVIEW_ACTIONS)
  action!: SpaceMemberPreviewAction;

  @IsOptional()
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  externalId?: string;

  @IsOptional()
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'addedByExternalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  addedByExternalId?: string;

  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsIn(SPACE_ROLES)
  role?: SpaceMemberRole;

  @IsOptional()
  @IsString()
  @Matches(EXTERNAL_ID, { message: 'actorExternalId must be 1-128 chars of [A-Za-z0-9._+-]' })
  actorExternalId?: string;

  @IsExpectedVersion()
  expectedVersion?: string;
}
