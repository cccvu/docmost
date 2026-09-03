import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
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
   * Ensure a fork-owned shadow member exists for the platform identity, and return its Docmost user id.
   * Idempotent (re-provision after a crash is safe): the synthetic email guarantees the upsert can only
   * ever match a row the fork owns, never a real Docmost user. Always a plain `member` — never elevated.
   */
  async provisionShadowUser(dto: ProvisionUserDto): Promise<string> {
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
        workspaceId: dto.workspaceId,
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
      `provisioned shadow member ${row.id} (externalId=${dto.externalId} ws=${dto.workspaceId})`,
    );
    return row.id;
  }

  /**
   * Mint a Docmost session for a fork-owned shadow user. This is DELIBERATELY NOT a "log in as anyone"
   * primitive: it refuses any user that is missing, deleted, privileged (`role != member`), or outside
   * the shadow namespace — so it can only ever produce a plain-member session for a user the platform
   * provisioned. Refusals are a uniform 403 (no enumeration); the specific reason is logged, not returned.
   */
  async mintSession(userId: string, workspaceId: string): Promise<string> {
    const user = await this.userRepo.findById(userId, workspaceId);
    const reason = this.disqualify(user);
    if (reason) {
      this.logger.warn(
        `service/session refused (${reason}) user=${userId} ws=${workspaceId}`,
      );
      throw new ForbiddenException('not a mintable shadow user');
    }
    const authToken = await this.sessionService.createSessionAndToken(user);
    this.logger.log(`minted session for shadow member ${userId} ws=${workspaceId}`);
    return authToken;
  }

  private disqualify(user?: User): string | null {
    if (!user) return 'no such user';
    if (user.deletedAt) return 'deleted';
    if (user.role !== 'member') return `privileged role ${user.role ?? 'null'}`;
    if (!isShadowEmail(user.email)) return 'outside shadow namespace';
    return null;
  }
}
