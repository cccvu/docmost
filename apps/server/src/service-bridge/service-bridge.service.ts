import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { hashPassword } from '../common/helpers';
import { SessionService } from '../core/session/session.service';
import { ProvisionUserDto } from './dto/provision-user.dto';
import { isShadowEmail, shadowEmailFor } from './shadow-user';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Session brokerage + shadow-user provisioning for the platform (or any implementer of the documented
 * service contract). Replaces the platform's former direct writes to Docmost's `users` table and its use
 * of native `/api/auth/login` — the fork now owns provisioning (writing its OWN database) and mints
 * sessions without a password. This is NOT a generic impersonation primitive (see `mintSession`).
 *
 * Both endpoints are keyed on the caller's opaque `externalId`; the fork — not the caller — derives the
 * shadow email and resolves the workspace, so the caller never handles Docmost-internal ids.
 */
@Injectable()
export class ServiceBridgeService {
  private readonly logger = new Logger(ServiceBridgeService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Ensure a fork-owned shadow member exists for the platform identity, and return its Docmost user id +
   * the workspace it lives in. Idempotent (re-provision after a crash is safe): the synthetic email
   * guarantees the upsert can only ever match a row the fork owns, never a real Docmost user. Always a
   * plain `member` — never elevated. The fork resolves its OWN default workspace so the caller stays
   * ignorant of Docmost's internal ids.
   */
  async provisionShadowUser(
    dto: ProvisionUserDto,
  ): Promise<{ userId: string; workspaceId: string }> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    const email = shadowEmailFor(dto.externalId);
    const name = dto.name?.trim() || dto.externalId;
    // Unusable password: sessions are minted (not password-logged-in), and native login is disabled in
    // remote mode anyway — so a random hash that no one holds is purely to satisfy the column shape.
    const password = await hashPassword(randomBytes(24).toString('base64url'));

    const row = await this.db
      .insertInto('users')
      .values({
        name,
        email,
        password,
        role: 'member',
        workspaceId,
        emailVerifiedAt: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['email', 'workspaceId']).doUpdateSet({
          emailVerifiedAt: new Date(),
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    this.logger.log(
      `provisioned shadow member ${row.id} (externalId=${dto.externalId} ws=${workspaceId})`,
    );
    return { userId: row.id, workspaceId };
  }

  /**
   * Mint a Docmost session for a fork-owned shadow user, named only by the caller's `externalId`. This is
   * DELIBERATELY NOT a "log in as anyone" primitive: the fork wraps `externalId` into the shadow namespace
   * itself, so the caller cannot select an arbitrary Docmost identity — and, as retained defense-in-depth,
   * it still refuses any resolved user that is missing, deleted, privileged (`role != member`), or (should
   * a row be tampered/mis-provisioned) outside the shadow namespace. Refusals are a uniform 403 (no
   * enumeration); the specific reason is logged, not returned.
   */
  async mintSession(externalId: string): Promise<string> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    const email = shadowEmailFor(externalId);
    const user = await this.userRepo.findByEmail(email, workspaceId);
    const reason = this.disqualify(user);
    if (reason) {
      this.logger.warn(
        `service/session refused (${reason}) externalId=${externalId} ws=${workspaceId}`,
      );
      throw new ForbiddenException('not a mintable shadow user');
    }
    const authToken = await this.sessionService.createSessionAndToken(user);
    this.logger.log(`minted session for shadow member ${user.id} ws=${workspaceId}`);
    return authToken;
  }

  /**
   * The fork's own default workspace (oldest, not soft-deleted) — the single-workspace assumption the
   * platform's BFF relied on, now owned by the fork so the caller never supplies a Docmost workspace id.
   * A not-yet-bootstrapped fork returns 503 (not ready to provision/mint), never a silent wrong workspace.
   */
  private async resolveDefaultWorkspaceId(): Promise<string> {
    const ws = await this.db
      .selectFrom('workspaces')
      .select('id')
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!ws) {
      throw new ServiceUnavailableException('no workspace provisioned');
    }
    return ws.id;
  }

  private disqualify(user?: User): string | null {
    if (!user) return 'no such user';
    if (user.deletedAt) return 'deleted';
    if (user.role !== 'member') return `privileged role ${user.role ?? 'null'}`;
    if (!isShadowEmail(user.email)) return 'outside shadow namespace';
    return null;
  }
}
