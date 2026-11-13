import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** The longest `keepToken` accepted: a fork access token is a few hundred characters. */
export const KEEP_TOKEN_MAX_LENGTH = 4096;
/** A compact JWS: three base64url segments. The fork still verifies the signature itself. */
export const KEEP_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/session/revoke-others`
 * (wiki-v2 #818): sign the identity out of every wiki session except the caller's own.
 *
 * `externalId` has the same charset guard as {@link SessionExternalIdDto}: the fork derives the shadow email
 * itself, so a caller can only ever name a shadow-namespace subject.
 *
 * `keepToken` MUST stay declared here. The app's ValidationPipe runs `whitelist` without
 * `forbidNonWhitelisted`, so an undeclared member is stripped silently, and the route would then revoke every
 * wiki session, the caller's current one included. It is only a hint: the fork keeps the session it names
 * only after verifying the token as its own access token for this shadow user.
 */
export class RevokeOtherSessionsDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._+-]{1,128}$/, {
    message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]',
  })
  externalId: string;

  @IsOptional()
  @IsString()
  @MaxLength(KEEP_TOKEN_MAX_LENGTH)
  @Matches(KEEP_TOKEN_PATTERN, { message: 'keepToken must be a compact JWS' })
  keepToken?: string;
}
