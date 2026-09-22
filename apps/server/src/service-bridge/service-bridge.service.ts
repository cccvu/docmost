import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'crypto';
import { isIP } from 'node:net';
import { ClsService } from 'nestjs-cls';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { User } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { hashPassword, isUserDisabled } from '../common/helpers';
import { SessionService } from '../core/session/session.service';
import {
  AuditContext,
  AUDIT_CONTEXT_KEY,
} from '../common/middlewares/audit-context.middleware';
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
    private readonly userSessionRepo: UserSessionRepo,
    private readonly sessionService: SessionService,
    private readonly workspaces: WorkspaceResolver,
    private readonly cls: ClsService,
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
    // CCC (real names): the platform owns the user's display name and passes it here. When a
    // name IS provided we (re)write it; when it is NOT — e.g. the space control-plane
    // re-provision, which knows only the externalId — we must NOT clobber an existing good
    // name with the UUID fallback, so `name` is included in the on-conflict update only when
    // the caller actually supplied one. On the first INSERT we still need a non-null value,
    // so fall back to the externalId there (a later named provision then heals it).
    const providedName = dto.name?.trim() || null;
    const insertName = providedName ?? dto.externalId;
    // Unusable password: sessions are minted (not password-logged-in), and native login is disabled in
    // remote mode anyway — so a random hash that no one holds is purely to satisfy the column shape.
    const password = await hashPassword(randomBytes(24).toString('base64url'));

    const row = await this.db
      .insertInto('users')
      .values({
        name: insertName,
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
      //   - refreshes `emailVerifiedAt`;
      //   - refreshes `name` ONLY when the caller supplied one (see the `providedName` note above) — a
      //     nameless re-provision preserves the existing name rather than resetting it to the UUID.
      // It deliberately does NOT touch `password` (never rewritten by an upsert). NOTE: it does NOT clear
      // `deactivatedAt` — a deliberate admin deactivation is not undone by a re-provision (and `disqualify`
      // still refuses a deactivated user via `isUserDisabled`).
      .onConflict((oc) =>
        oc.columns(['email', 'workspaceId']).doUpdateSet({
          ...(providedName ? { name: providedName } : {}),
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
   * #486 — the shadow user id for a platform identity WITHOUT provisioning one. For identities that are only
   * COMPARED, never written (the actor of a member re-role, rule M): a never-provisioned identity has no Docmost
   * user, so it cannot be — or be in a group that is — the subject of any membership row, and creating a user
   * just to compare would be a side effect. Same derivation + lookup as mint/deactivate: the lower-cased shadow
   * email (so an id's case variants resolve to ONE user), soft-deleted rows included (a membership row can still
   * reference one).
   */
  async findShadowUserId(externalId: string): Promise<string | null> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const user = await this.userRepo.findByEmail(shadowEmailFor(externalId), workspaceId);
    return user?.id ?? null;
  }

  /**
   * Mint a Docmost session for a fork-owned shadow user, named only by the caller's `externalId`. This is
   * DELIBERATELY NOT a "log in as anyone" primitive: the fork wraps `externalId` into the shadow namespace
   * itself, so the caller cannot select an arbitrary Docmost identity — and, as retained defense-in-depth,
   * it still refuses any resolved user that is missing, deleted, privileged (`role != member`), or (should
   * a row be tampered/mis-provisioned) outside the shadow namespace. Refusals are a uniform 403 (no
   * enumeration); the specific reason is logged, not returned.
   */
  async mintSession(externalId: string, clientIp?: string): Promise<string> {
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
    // #330: record the PLATFORM-resolved client IP on the new session, not the loopback relay peer Docmost
    // observes on this east-west hop. MUST run before createSessionAndToken, which reads `ipAddress` from
    // the CLS audit context (session.service.ts).
    this.applyClientIp(clientIp);
    const authToken = await this.sessionService.createSessionAndToken(user);
    this.logger.log(`minted session for shadow member ${user.id} ws=${workspaceId}`);
    return authToken;
  }

  /**
   * #455 — fork-side instant revocation. Deactivate a fork-owned shadow user so a disabled platform
   * identity can no longer read/write wiki content through an already-issued fork credential: set
   * `deactivatedAt` (the platform-wide `isUserDisabled` predicate every fork auth entrypoint enforces —
   * `jwt.strategy` on `/api/*`, `onAuthenticate` on new collab connections, and `mintSession.disqualify`
   * on re-mint) AND revoke its live `user_sessions` (so `/api/*` is cut on the very next request). The
   * caller (platform `disable()`) additionally force-disconnects the user's LIVE collab sockets via the
   * gateway — see the controller.
   *
   * Keyed only on the caller's opaque `externalId`; the fork derives the shadow email + resolves the
   * workspace, so a caller can only ever deactivate a shadow-namespace subject. IDEMPOTENT (re-stamping
   * `deactivatedAt` and re-revoking already-revoked sessions are both no-ops) so it composes with
   * `disable()`'s non-atomic retry-before-enable teardown. A never-provisioned identity (no shadow user)
   * is a benign no-op success. Sets `deactivatedAt`, NEVER `deletedAt` (disable is reversible; soft-delete
   * is a different, one-way lifecycle). We deliberately do NOT call the native `deactivateUser`
   * (workspace.service.ts): it is upstream, requires an admin `authUser` context, and throws
   * "already deactivated" — incompatible with idempotent retry.
   */
  async deactivateShadowUser(externalId: string): Promise<{
    userId: string | null;
    deactivated: boolean;
    sessionsRevoked: number;
  }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const email = shadowEmailFor(externalId);
    const user = await this.userRepo.findByEmail(email, workspaceId);
    if (!user) {
      // Never-logged-in identity: nothing to deactivate. A benign no-op, not an error — the platform kill
      // is already complete on its side and there is no fork credential to revoke.
      return { userId: null, deactivated: false, sessionsRevoked: 0 };
    }
    // Count active sessions for the audit trail BEFORE the sweep (an informational number; a session
    // racing in between is irrelevant to the security outcome, which `deactivatedAt` enforces regardless).
    const active = await this.userSessionRepo.findActiveByUser(
      user.id,
      workspaceId,
    );
    await executeTx(this.db, async (trx) => {
      await this.userRepo.updateUser(
        { deactivatedAt: new Date() },
        user.id,
        workspaceId,
        trx,
      );
      await this.userSessionRepo.revokeByUserId(user.id, workspaceId, trx);
    });
    this.logger.log(
      `deactivated shadow user ${user.id} (externalId=${externalId} ws=${workspaceId} sessionsRevoked=${active.length})`,
    );
    return { userId: user.id, deactivated: true, sessionsRevoked: active.length };
  }

  /**
   * #455 — paired with {@link deactivateShadowUser}: clear `deactivatedAt` so a re-enabled platform
   * identity can sign in and use the wiki again. The provision upsert deliberately does NOT clear
   * `deactivatedAt` (a re-provision must not silently undo an admin deactivation), so this explicit restore
   * is the ONLY path back. IDEMPOTENT: a no-op success when there is no shadow user or it is already
   * active. Revives NO sessions/keys/tokens (those are terminally revoked platform-side, #117) — re-enable
   * forces a fresh login. Touches ONLY `deactivatedAt`, never `deletedAt`.
   */
  async reactivateShadowUser(externalId: string): Promise<{
    userId: string | null;
    reactivated: boolean;
  }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const email = shadowEmailFor(externalId);
    const user = await this.userRepo.findByEmail(email, workspaceId);
    if (!user || !user.deactivatedAt) {
      // No shadow user yet, or already active — nothing to clear. Benign no-op.
      return { userId: user?.id ?? null, reactivated: false };
    }
    await this.userRepo.updateUser(
      { deactivatedAt: null },
      user.id,
      workspaceId,
    );
    this.logger.log(
      `reactivated shadow user ${user.id} (externalId=${externalId} ws=${workspaceId})`,
    );
    return { userId: user.id, reactivated: true };
  }

  /**
   * #330 — overwrite the CLS audit context's `ipAddress` with the platform-resolved client IP so the minted
   * session records where the human actually signed in from. `AuditContextMiddleware` already ran on this
   * loopback `/api/service/session` request and set `ipAddress` to the relay peer (`127.0.0.1`), so we
   * ALWAYS overwrite — never leave it — or the session would persist that confidently-wrong value (the bug
   * this fixes). A valid non-loopback address is stored; anything else (absent / junk / loopback /
   * unspecified) becomes NULL: the honest "not known", and the only value safe for the `inet` column (a
   * non-address would 500 the INSERT). Mirrors PlatformAuditService.setActorId's get→mutate→set.
   */
  private applyClientIp(clientIp?: string): void {
    const resolved = this.trustedClientIp(clientIp);
    const ctx = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (ctx) {
      ctx.ipAddress = resolved;
      this.cls.set(AUDIT_CONTEXT_KEY, ctx);
    }
    // No context (a mint outside the request middleware — none exists today): session.service.ts defaults
    // ipAddress to null, so there is nothing unsafe to record.
  }

  /**
   * A syntactically valid, non-loopback/unspecified client IP, else null. The platform is the trust source
   * (it resolved this from its own trusted-proxy predicate) — this is a defensive scalar check so a junk or
   * relay-peer value can never reach the `inet` `ip_address` column. Loopback in the spellings that reach us
   * (`::1`, `127.0.0.0/8`, dual-stack `::ffff:127.*`) and the unspecified address are "not a client".
   */
  private trustedClientIp(clientIp?: string): string | null {
    const ip = clientIp?.trim();
    if (!ip || isIP(ip) === 0) return null;
    // A scoped/zoned IPv6 literal (`fe80::1%eth0`) passes `net.isIP` (→ 6) but Postgres `inet` REJECTS the
    // `%zone` suffix, so storing it would 500 the INSERT — the exact non-address crash this check exists to
    // stop. A zoned address is link-local and never a real remote client anyway, so → null.
    if (ip.includes('%')) return null;
    const v = ip.toLowerCase();
    const v4 = v.startsWith('::ffff:') ? v.slice('::ffff:'.length) : v;
    if (v === '::1' || v === '::' || v4.startsWith('127.') || v4 === '0.0.0.0') {
      return null;
    }
    return ip;
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
