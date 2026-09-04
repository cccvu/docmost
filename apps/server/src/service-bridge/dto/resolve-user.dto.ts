import { IsUUID } from 'class-validator';

/** CCC service-bridge — NOT upstream Docmost code. Input for `POST /api/service/users/resolve`. */
export class ResolveUserDto {
  /** A Docmost user id whose workspace the caller needs (existence check + workspace lookup). */
  @IsUUID()
  userId!: string;
}
