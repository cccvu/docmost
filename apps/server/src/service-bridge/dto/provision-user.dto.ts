import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/users`. */
export class ProvisionUserDto {
  /**
   * The platform's canonical identity id. The FORK derives the synthetic shadow email from it and owns
   * the namespace — the caller never supplies a raw email (no impersonation of a chosen address). The
   * charset is constrained to safe local-part characters so it cannot inject an `@`, domain, or
   * whitespace into the derived email.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9._+-]{1,128}$/, {
    message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]',
  })
  externalId: string;

  /**
   * Optional human-readable display name for the shadow member. The fork owns workspace selection (it
   * resolves its own default workspace), so the caller never supplies a Docmost workspace id.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}
