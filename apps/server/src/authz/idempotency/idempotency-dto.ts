import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_NAMESPACE_MAX_LENGTH,
  REQUEST_FINGERPRINT_PATTERN,
} from './idempotency-ledger.service';

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * The three request fields a keyed create carries, as reusable class-validator decorators (a keyed route marks them
 * required; a route where the key is optional adds `@IsOptional()` beside them). The platform already validated the
 * key's grammar at its edge; the fork re-checks only what its ledger relies on: non-empty, bounded, and a well-formed
 * fingerprint.
 */

/** The caller's `Idempotency-Key`, 1–255 characters. Only its sha256 is stored. */
export function IsIdempotencyKey(): PropertyDecorator {
  return applyDecorators(IsString(), MinLength(1), MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH));
}

/** The caller's opaque key namespace (the platform's idempotency subject), 1–128 characters. */
export function IsIdempotencyNamespace(): PropertyDecorator {
  return applyDecorators(IsString(), MinLength(1), MaxLength(IDEMPOTENCY_NAMESPACE_MAX_LENGTH));
}

/** sha256 hex (64 lowercase hex digits) of the caller's stable request body. */
export function IsRequestFingerprint(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    Matches(REQUEST_FINGERPRINT_PATTERN, { message: 'fingerprint must be 64 lowercase hex digits (sha256)' }),
  );
}
