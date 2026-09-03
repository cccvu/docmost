import { IsUUID } from 'class-validator';

/** CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/session`. */
export class MintSessionDto {
  /** The Docmost user id to mint a session for. Must be a fork-owned shadow member (enforced server-side). */
  @IsUUID()
  userId: string;

  @IsUUID()
  workspaceId: string;
}
