import { SetMetadata } from '@nestjs/common';

/**
 * CCC route-decision decorators — NOT upstream Docmost code (GitHub #13, Layer C).
 *
 * A first-class way for FORK-OWNED handlers to declare their authorization decision, mirroring the
 * platform's `authz/metadata.ts`. They exist so a new fork-owned route is decided by a decorator (read by
 * the fail-closed PlatformAuthorizationGuard) rather than by convention. Upstream Docmost handlers are NOT
 * annotated (the "modify-minimally" rule forbids editing their controllers) — they are recognized by their
 * existing `@UseGuards(JwtAuthGuard)` / `@Public()` or classified in the intentional-unguarded ledger.
 */
export const PLATFORM_AUTHZ_KEY = 'platform:authz';
export const PLATFORM_PUBLIC_KEY = 'platform:public';

export interface PlatformAuthzMeta {
  resource: string;
  action: string;
  idParam: string;
}

/** Require an authenticated principal + (future) an object-level PDP decision for a fork-owned route. */
export const PlatformAuthz = (resource: string, action: string, idParam = 'id') =>
  SetMetadata(PLATFORM_AUTHZ_KEY, { resource, action, idParam } satisfies PlatformAuthzMeta);

/** Explicitly public fork-owned route (anonymous access is intended). */
export const PlatformPublic = () => SetMetadata(PLATFORM_PUBLIC_KEY, true);
