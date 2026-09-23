import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { InjectKysely } from 'nestjs-kysely';
import { Observable, from, mergeMap } from 'rxjs';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { maxCommittedPosition } from '../../service-bridge/authz-change-feed.service';
import { LiveAccessRevalidator } from './live-access.revalidator';
import { NARROWING_ROUTES } from './narrowing-routes';

export const AUTHZ_PROPAGATION_HEADER = 'Authz-Propagation';

const DEFAULT_SETTLE_MS = 3000;
const MAX_SETTLE_MS = 5000;
/** The whole narrowing request (handler + settle + live-session re-check) is kept under this, so a relayed call
 *  (the platform's relay and service clients time out at 8 s) never turns a change that SUCCEEDED into a 504. */
export const REQUEST_BUDGET_MS = 6000;
/** How long the response waits for this node's live-session re-check after a confirmed settle. */
export const REVALIDATE_WAIT_MS = 1500;

/** `AUTHZ_NARROWING_SETTLE_TIMEOUT_MS`: default 3000, clamped to 5000; `0` turns the interceptor into a
 *  pass-through (no wait, no header) — the tuning knob and the rollback switch. */
export function narrowingSettleTimeoutMs(
  raw = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SETTLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SETTLE_MS;
  return Math.min(Math.trunc(n), MAX_SETTLE_MS);
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#501 Part B, ADR 0026 §4).
 *
 * Confirm-before-respond for the routes that take access away (`narrowing-routes.ts`). A narrowing change commits
 * here first and reaches the PDP through the outbox → platform relay; until then, decisions still allow the old
 * access. So on such a route (remote mode only):
 *   0. before the handler, read the current fence; after it SUCCEEDS, read it again. Unchanged means nothing was
 *      committed to the outbox meanwhile — this request changed no access (a same-parent reorder, a no-op) — so
 *      there is nothing to settle and no header (unknown). Our own rows always move it: their transaction id is
 *      assigned after the first read, so they sort after everything committed before it;
 *   1. the fence `P` = that max committed outbox position (`maxCommittedPosition`, never the xmin-gated head);
 *   2. ask the platform to settle to `P` (`POST /sync/settle`, bounded) — `confirmed` means the relay projected
 *      every access change committed up to now, this request's included, and refreshed the watermark;
 *   3. on `confirmed`, give this node's live connections a re-check (bounded; other nodes' sweeps are the bound);
 *   4. set `Authz-Propagation: confirmed | pending`. A `pending` the platform did not itself answer (it was
 *      unreachable, had no route, or timed out) is logged here with the alarmed `AUTHZ_PROPAGATION_PENDING`; one it
 *      answered was already logged and alarmed there.
 * The fence is GLOBAL on purpose: the outbox rows come from triggers inside upstream transactions that name no
 * request, and a per-request fence could under-wait (a move-to-space writes rows about the whole subtree), which
 * would report `confirmed` for a change that is not enforced. A global fence can only over-wait, bounded.
 *
 * It never throws and never changes the status or the body: the change is committed either way, so the only
 * question is whether the caller is told it is enforced. Errors from the handler pass through untouched.
 */
@Injectable()
export class NarrowingSettleInterceptor implements NestInterceptor {
  private readonly logger = new Logger(NarrowingSettleInterceptor.name);
  private readonly settleMs = narrowingSettleTimeoutMs();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly authz: HttpAuthzClient,
    private readonly liveAccess: LiveAccessRevalidator,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      this.mode !== 'remote' ||
      this.settleMs === 0 ||
      context.getType() !== 'http'
    ) {
      return next.handle();
    }
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!NARROWING_ROUTES.has(route)) return next.handle();
    const startedAt = Date.now();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    // null = unknown (the read failed): then settle anyway, never skip on a guess.
    const before = maxCommittedPosition(this.db).catch(() => null);
    return from(before).pipe(
      mergeMap((fenceBefore) =>
        next.handle().pipe(
          mergeMap(async (body) => {
            const verdict = await this.settle(route, startedAt, fenceBefore);
            if (verdict && !reply.sent) {
              reply.header(AUTHZ_PROPAGATION_HEADER, verdict);
            }
            return body;
          }),
        ),
      ),
    );
  }

  /** The verdict for the header, or null when this request committed no access change (no header). */
  private async settle(
    route: string,
    startedAt: number,
    fenceBefore: string | null,
  ): Promise<'confirmed' | 'pending' | null> {
    const left = () => REQUEST_BUDGET_MS - (Date.now() - startedAt);
    let position = '?';
    try {
      position = await maxCommittedPosition(this.db);
      if (fenceBefore !== null && position === fenceBefore) return null;
      const waitMs = Math.max(
        0,
        Math.min(this.settleMs, left() - REVALIDATE_WAIT_MS),
      );
      const settled = await this.authz.settleProjection(position, waitMs);
      if (settled.status !== 'confirmed') {
        if (settled.reason.startsWith('settle-')) {
          // No verdict from the platform, so nothing was logged there: this line is the alarm.
          this.logger.warn(
            `AUTHZ_PROPAGATION_PENDING reason=${settled.reason} route=${route} position=${position} ` +
              `the fork got no settle verdict from the platform; the narrowing change is saved but not shown enforced`,
          );
        } else {
          this.logger.warn(
            `narrowing change answered before the PDP enforced it (Authz-Propagation: pending): route=${route} ` +
              `position=${position} reason=${settled.reason}`,
          );
        }
        return 'pending';
      }
      await this.revalidateLocal(
        Math.max(0, Math.min(REVALIDATE_WAIT_MS, left())),
      );
      return 'confirmed';
    } catch (e) {
      this.logger.warn(
        `AUTHZ_PROPAGATION_PENDING reason=settle-fence-unreadable route=${route} position=${position} ` +
          `the narrowing change is saved but its settle failed: ${(e as Error).message}`,
      );
      return 'pending';
    }
  }

  /** This node's live connections, bounded: the PDP already enforces the change, so a slow pass only delays the
   *  close of an open editor (the revalidator keeps going, and every node's sweep is the bound). */
  private async revalidateLocal(waitMs: number): Promise<void> {
    const pass = this.liveAccess.signal('narrowing').catch(() => undefined); // failures are logged by the pass
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([pass, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
