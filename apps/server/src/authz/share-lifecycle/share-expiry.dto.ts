import { IsIn, IsUUID, ValidateIf } from 'class-validator';
import { SHARE_EXPIRY_PRESET_DAYS, ShareExpiryPresetDays } from './share-expiry.sql';

/** `POST /api/shares/expiry/info`. The share's uuid (never its key). */
export class ShareExpiryInfoDto {
  @IsUUID()
  shareId: string;
}

/**
 * `POST /api/shares/expiry`. `expiresInDays` is REQUIRED: one of the presets, or an explicit `null` ("Never").
 * Anything else — absent, a string ("30"), another number, a fraction — is a 400: the global ValidationPipe has no
 * implicit conversion, and `@IsIn` compares strictly. Unknown properties are stripped by the pipe's whitelist.
 */
export class SetShareExpiryDto {
  @IsUUID()
  shareId: string;

  @ValidateIf((o: SetShareExpiryDto) => o.expiresInDays !== null)
  @IsIn([...SHARE_EXPIRY_PRESET_DAYS])
  expiresInDays: ShareExpiryPresetDays | null;
}
