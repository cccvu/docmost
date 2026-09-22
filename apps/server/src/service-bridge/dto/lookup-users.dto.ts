import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
} from 'class-validator';

/**
 * CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/users/lookup` (#486).
 *
 * Canonical platform identity ids, same charset guard as {@link ProvisionUserDto}: the FORK derives each shadow
 * email itself, so a caller can only ever name a shadow-namespace subject. Capped at 256 — the same bound as a
 * /v1 page-permission revoke, the caller this exists for.
 */
export class LookupUsersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9._+-]{1,128}$/, {
    each: true,
    message: 'each externalId must be 1-128 chars of [A-Za-z0-9._+-]',
  })
  externalIds: string[];
}
