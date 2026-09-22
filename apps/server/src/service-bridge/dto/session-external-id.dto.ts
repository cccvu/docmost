import { IsString, Matches } from 'class-validator';

/**
 * CCC service-bridge — NOT upstream Docmost code. Input for the session-lifecycle side-effect endpoints
 * `POST /api/service/session/revoke` and `POST /api/service/session/restore` (#455).
 *
 * Same shape and charset guard as {@link MintSessionDto}: the caller supplies only its canonical identity
 * id and the FORK derives the shadow email (`shadowEmailFor(externalId)`) + resolves the workspace, so a
 * caller can only ever name a shadow-namespace subject — it can never ask the fork to deactivate an
 * arbitrary Docmost user, a real account, or a privileged account. The charset guard forbids injecting an
 * `@`, a domain, or whitespace into the derived email.
 */
export class SessionExternalIdDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._+-]{1,128}$/, {
    message: 'externalId must be 1-128 chars of [A-Za-z0-9._+-]',
  })
  externalId: string;
}
