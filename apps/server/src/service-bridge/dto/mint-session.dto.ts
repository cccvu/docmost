import { IsString, Matches } from 'class-validator';

/** CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/session`. */
export class MintSessionDto {
  /**
   * The caller's canonical identity id (same value used for provisioning). The FORK — not the caller —
   * derives the shadow email (`shadowEmailFor(externalId)`) and resolves the workspace, so a caller can
   * only ever name a shadow-namespace subject: it cannot ask the fork to mint a session for an arbitrary
   * Docmost user by id, a real account by email, or a privileged account. Same charset guard as
   * provisioning so it cannot inject an `@`, domain, or whitespace into the derived email.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9._+-]{1,128}$/, {
    message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]',
  })
  externalId: string;
}
