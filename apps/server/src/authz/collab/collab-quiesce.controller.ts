import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';

/** The quiesce answer: the drain stays on; what it left resident, and which of those hold a failed store. */
export interface CollabQuiesceResponse {
  draining: true;
  resident: number;
  failed: string[];
}

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #919, F7).
 *
 * The collab quiesce, for a maintenance window that must lose no acknowledged edit (the RPO = 0 freeze before the ALB
 * maintenance rule, scale-down and the database fence). The platform relays its admin route
 * (`POST /admin/maintenance/collab-quiesce`, a fresh-auth workspace admin) here; nothing else calls it.
 *
 *   - `POST /api/collab/quiesce`: runs the collab drain (authz/collab-ingress/collab-quiesce.ts, the one the shutdown
 *     runs) and answers `{ draining: true, resident, failed }`: documents still loaded or loading, and the names of
 *     those whose last store failed (kept in memory and retried). The drain is sticky: from the first call until the
 *     abort or the process exits, no frame applies, nothing loads, no direct write or inline comment is accepted.
 *     Idempotent; each call does at most ~40 s of draining work (under the ALB's 60 s idle timeout), so the caller
 *     calls again until `resident` is 0 and `failed` is empty.
 *   - `POST /api/collab/quiesce/abort`: lifts the drain (`{ draining: false }`). The only way to lift it.
 *
 * No PDP decision: it narrows nothing and grants nothing; the platform made the admin decision. `RemoteOnlyGuard` 404s
 * it unless AUTHZ_MODE=remote; `CollabServiceSecretGuard` verifies the shared service secret (the flush and revalidate
 * routes' auth). Bare bodies (`@SkipTransform`), as every east-west route.
 */
@UseGuards(RemoteOnlyGuard, CollabServiceSecretGuard)
@Controller('collab')
export class CollabQuiesceController {
  constructor(private readonly gateway: CollaborationGateway) {}

  @HttpCode(HttpStatus.OK)
  @SkipTransform()
  @Post('quiesce')
  async quiesce(): Promise<CollabQuiesceResponse> {
    const { resident, failed } = await this.gateway.quiesce();
    return { draining: true, resident, failed: [...failed] };
  }

  @HttpCode(HttpStatus.OK)
  @SkipTransform()
  @Post('quiesce/abort')
  abort(): { draining: false } {
    this.gateway.endQuiesce();
    return { draining: false };
  }
}
