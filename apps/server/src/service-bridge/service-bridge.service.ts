import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { hashPassword, isUserDisabled } from '../common/helpers';
import { SessionService } from '../core/session/session.service';
import { ProvisionUserDto } from './dto/provision-user.dto';
import { isShadowEmail, shadowEmailFor } from './shadow-user';
import { WorkspaceResolver } from './workspace-resolver';

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
    private readonly workspaces: WorkspaceResolver,
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
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
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
      // Idempotent re-provision is a self-HEAL, not just a touch (#272 P5 + companion F3): a shadow row
      // the fork itself owns (guaranteed by the reserved-domain email = the conflict key) must come back in
      // the exact "plain, live member" shape provisioning promises. So the conflict update:
      //   - clears `deletedAt` — a soft-deleted shadow user (fork DB restore, offboard) is resurrected
      //     (without this, `mintSession` refuses "deleted"/"disabled" forever — #272 P5);
      //   - forces `role: 'member'` — an out-of-band-elevated shadow row is de-escalated back to plain
      //     member (the literal is never caller-supplied, so this STRENGTHENS the no-escalation property:
      //     the upsert can only ever write `'member'`, never a privileged role — the sibling `space_members`
      //     upsert resets `role` the same way);
      //   - refreshes `name` and `emailVerifiedAt`.
      // It deliberately does NOT touch `password` (never rewritten by an upsert). NOTE: it does NOT clear
      // `deactivatedAt` — a deliberate admin deactivation is not undone by a re-provision (and `disqualify`
      // still refuses a deactivated user via `isUserDisabled`).
      .onConflict((oc) =>
        oc.columns(['email', 'workspaceId']).doUpdateSet({
          name,
          emailVerifiedAt: new Date(),
          deletedAt: null,
          role: 'member',
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
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
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

  private disqualify(user?: User): string | null {
    if (!user) return 'no such user';
    // Companion F1: "not usable" is the platform-wide `isUserDisabled` (deactivatedAt OR deletedAt), the
    // same predicate every native auth entrypoint enforces (jwt.strategy, token/auth services). Checking
    // only `deletedAt` here was a fail-OPEN divergence: a workspace-admin-DEACTIVATED shadow member (which
    // sets `deactivatedAt`, not `deletedAt`) would still mint a live session.
    if (isUserDisabled(user)) return 'disabled';
    if (user.role !== 'member') return `privileged role ${user.role ?? 'null'}`;
    if (!isShadowEmail(user.email)) return 'outside shadow namespace';
    return null;
  }
}
