import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Request body for the anonymous public-content discovery list.
 * `limit` is additionally clamped server-side (see PublicDiscoveryService); the
 * validator only rejects obviously-bad input so nothing unbounded reaches the DB.
 */
export class ListPublicPagesDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}
