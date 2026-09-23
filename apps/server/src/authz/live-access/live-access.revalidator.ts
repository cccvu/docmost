import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { WsGateway } from '../../ws/ws.gateway';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { AuthzCheckItem, HttpAuthzClient } from '../http-authz.client';
import {
  CollabAccess,
  decideCollabAccess,
  PagePermissions,
  SpacePermissions,
} from './collab-access.decision';
import {
  lineageRestricted,
  readPageLineage,
} from '../../service-bridge/page-lineage';

/**
 * CCC authorization integration — NOT upstream Docmost code (#501).
 *
 * Re-checks every LIVE realtime connection on this node against the PDP and narrows the ones that lost access.
 * Upstream authorizes a collab socket and a notifications socket once, at connect; before this, a narrowing
 * change (restrict, member removal or demotion, space archive, group-grant removal, a role-binding revoke) left
 * an open editor syncing and an open notifications socket receiving the space's tree titles and comment bodies
 * until it happened to reconnect.
 *
 * Two triggers, one pass:
 *   - the fast path: the platform signals `POST /api/collab/revalidate` right after it projects a narrowing
 *     change (the relay, the reconciler, admin demote); a trailing pass 2 s later catches a connection whose
 *     connect-time decision raced the projection;
 *   - the sweep: every `LIVE_ACCESS_SWEEP_INTERVAL_MS` (default 60 s, 0 = off), on EVERY node. It is the
 *     bound for anything the fast path missed (a lost signal, a dead-lettered event later repaired, another
 *     node's documents, a native deactivate that emits no event).
 *
 * What it does, per connection:
 *   - collab: `decideCollabAccess` (a mirror of `onAuthenticate`, including the #524 lineage read for a page the
 *     PDP has not placed — read only for those pages, once per pass). `deny`, or `read` on a writable
 *     connection, closes it (`connection.close()`, the #455 pattern). Closing rather than flipping `readOnly`
 *     is deliberate: the client re-authenticates on reconnect, so a transient decision (e.g. between the
 *     delete and the insert of a non-atomic re-grant) heals itself instead of silently dropping the user's
 *     edits for the rest of the session.
 *   - socket.io: every joined `space-<id>` room is re-checked for space `view`; `false` leaves the room. A
 *     missing or disabled user is disconnected.
 *   - `unknown` (the PDP or the DB failed) does nothing, so a blip never mass-evicts. A connection that stays
 *     unknown for at least UNKNOWN_CAP consecutive passes AND UNKNOWN_GRACE_MS is narrowed anyway (fail closed,
 *     bounded) and `LIVE_ACCESS_REVALIDATE_FAILED` is logged. Both bounds are needed: fast-path passes run
 *     250 ms to 2 s apart during a burst of signals, so a pass count alone would turn a few seconds of PDP
 *     slowness into closing every editor on the node.
 *
 * It NEVER widens: it never sets `readOnly = false`, never joins a room (a static spec pins both). Only the
 * decision API that reports failure (`tryCheckBulk`) is used; the fail-closed repos would read a PDP error as
 * a deny and evict everyone.
 *
 * NODE-LOCAL: it sees this node's resident documents and sockets. A RedisSync-proxied collab client lives on
 * the node that owns the document, so every node sweeping its own connections covers the cluster (#479).
 */
export interface LiveAccessSummary {
  /** Connections (collab) + joined space rooms (socket.io) examined. */
  checked: number;
  /** Collab connections closed. */
  closed: number;
  /** socket.io space rooms left. */
  left: number;
  /** socket.io sockets disconnected (user missing or disabled). */
  disconnected: number;
  /** Decisions that came back unknown this pass. */
  unknown: number;
  /** Narrowed only because the unknown cap was reached. */
  unknownClosed: number;
}

/** A resident Hocuspocus connection, structurally (keeps this file off the Hocuspocus/lib0 import graph). */
export interface LiveCollabConnection {
  readonly readOnly: boolean;
  readonly context?: { user?: { id?: string; workspaceId?: string } };
  close(): void;
}

export interface LiveCollabDocument {
  readonly name: string;
  getConnections(): Iterable<LiveCollabConnection>;
}

/** A local socket.io socket, structurally. */
export interface LiveSocket {
  readonly data: { userId?: string; workspaceId?: string };
  readonly rooms: Set<string>;
  leave(room: string): unknown;
  disconnect(close?: boolean): unknown;
}

export type RevalidateSource = 'signal' | 'narrowing' | 'trailing' | 'sweep';

/** The platform caps a bulk check at 256 items; stay well under it (issue 492 used 128 too). */
const CHECK_CHUNK = 128;
/** Consecutive unknown passes before a connection is narrowed anyway... */
export const UNKNOWN_CAP = 3;
/** ...and for at least this long since its first unknown (a pass count alone collapses to seconds under a
 *  burst of fast-path signals). Two default sweep intervals. */
export const UNKNOWN_GRACE_MS = 120_000;
/** Minimum gap between two passes; bursts of signals collapse into the one queued pass. */
const MIN_GAP_MS = 250;
/** The trailing pass after a signal: covers a connection that authenticated before the projection landed. */
const TRAILING_PASS_MS = 2000;
/** Users processed concurrently within one pass (each is one user read, its page reads and one bulk check). */
const USER_CONCURRENCY = 4;
const SPACE_ROOM_PREFIX = 'space-';
const FAILED_LOG_THROTTLE_MS = 60_000;

function sweepIntervalMs(): number {
  const n = Number.parseInt(
    process.env.LIVE_ACCESS_SWEEP_INTERVAL_MS ?? '',
    10,
  );
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/** `page.<id>` → `<id>`. Re-implemented here: `collaboration.util` pulls in the tiptap/yjs graph. */
function pageKeyOf(documentName: string): string | null {
  const key = documentName.split('.')[1];
  return key ? key : null;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });

@Injectable()
export class LiveAccessRevalidator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveAccessRevalidator.name);
  private current: Promise<LiveAccessSummary> | null = null;
  private queued: Promise<LiveAccessSummary> | null = null;
  private lastPassEndedAt = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastFailedLogAt = 0;
  /** Consecutive unknown decisions (and when the run began), per collab connection / per socket+room. Weak: a
   *  closed connection frees it. */
  private readonly unknownCollab = new WeakMap<object, UnknownRun>();
  private readonly unknownRooms = new WeakMap<
    object,
    Map<string, UnknownRun>
  >();

  constructor(
    private readonly collab: CollaborationGateway,
    private readonly ws: WsGateway,
    private readonly userRepo: UserRepo,
    private readonly pageRepo: PageRepo,
    private readonly authz: HttpAuthzClient,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  onModuleInit(): void {
    if (this.mode !== 'remote') return; // native mode: the fork's own repos decide at connect; no PDP to track
    this.armSweep();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
  }

  /**
   * Resolve with the summary of a pass that STARTS after this call (so a caller that just changed access is
   * guaranteed a pass that sees it). Concurrent callers share passes: at most one runs and one is queued.
   */
  request(source: RevalidateSource): Promise<LiveAccessSummary> {
    if (!this.current) return this.start(source);
    if (!this.queued) {
      this.queued = this.current
        .catch(() => undefined)
        .then(async () => {
          const gap = MIN_GAP_MS - (Date.now() - this.lastPassEndedAt);
          if (gap > 0) await sleep(gap);
          this.queued = null;
          return this.current ?? this.start(source);
        });
    }
    return this.queued;
  }

  /** A fast-path signal: a pass now, and a trailing pass shortly after (one pending trailing timer at most). */
  signal(source: RevalidateSource): Promise<LiveAccessSummary> {
    if (!this.trailingTimer && !this.stopped) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        void this.request('trailing').catch(() => undefined);
      }, TRAILING_PASS_MS);
      (this.trailingTimer as unknown as { unref?: () => void }).unref?.();
    }
    return this.request(source);
  }

  private start(source: RevalidateSource): Promise<LiveAccessSummary> {
    const run = this.runPass(source).finally(() => {
      this.lastPassEndedAt = Date.now();
      if (this.current === run) this.current = null;
    });
    this.current = run;
    return run;
  }

  private armSweep(): void {
    const interval = sweepIntervalMs();
    if (interval <= 0 || this.stopped) return;
    const jitter = interval * 0.1 * (Math.random() * 2 - 1);
    this.sweepTimer = setTimeout(
      async () => {
        this.sweepTimer = null;
        try {
          await this.request('sweep');
        } catch {
          /* runPass already logged */
        }
        this.armSweep();
      },
      Math.max(1000, interval + jitter),
    );
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async runPass(source: RevalidateSource): Promise<LiveAccessSummary> {
    const t0 = Date.now();
    const s: LiveAccessSummary = {
      checked: 0,
      closed: 0,
      left: 0,
      disconnected: 0,
      unknown: 0,
      unknownClosed: 0,
    };
    try {
      const users = new UserCache(this.userRepo);
      await this.revalidateCollab(s, users, new LineageCache(this.db));
      await this.revalidateSockets(s, users);
    } catch (e) {
      this.logFailed(
        `source=${source} live connections were not re-checked this pass (the next signal or sweep retries): ${(e as Error).message}`,
      );
      throw e;
    }
    if (s.unknownClosed > 0) {
      // The I/O failure path: the PDP or the fork DB did not answer for these connections for at least
      // UNKNOWN_GRACE_MS, so they were narrowed without a decision (fail closed). Operator-worthy.
      this.logFailed(
        `source=${source} unknownClosed=${s.unknownClosed} unknown=${s.unknown} the PDP or the fork DB could not answer for these connections for ${UNKNOWN_GRACE_MS / 1000}s+; they were narrowed without a decision (fail closed)`,
      );
    }
    if (s.closed + s.left + s.disconnected > 0) {
      this.logger.log(
        `LIVE_ACCESS_REVOKED source=${source} closed=${s.closed} left=${s.left} disconnected=${s.disconnected} unknownClosed=${s.unknownClosed} checked=${s.checked} unknown=${s.unknown} ms=${Date.now() - t0}`,
      );
    }
    return s;
  }

  private logFailed(detail: string): void {
    const now = Date.now();
    if (now - this.lastFailedLogAt < FAILED_LOG_THROTTLE_MS) return;
    this.lastFailedLogAt = now;
    this.logger.error(`LIVE_ACCESS_REVALIDATE_FAILED ${detail}`);
  }

  // ── collab ────────────────────────────────────────────────────────────────────────────────────────
  private async revalidateCollab(
    s: LiveAccessSummary,
    users: UserCache,
    lineages: LineageCache,
  ): Promise<void> {
    // Snapshot first: closing a connection (or its document unloading) mutates the live maps.
    const entries: {
      conn: LiveCollabConnection;
      userId: string;
      workspaceId: string;
      pageKey: string;
    }[] = [];
    for (const doc of this.collab.getResidentDocuments() as Iterable<LiveCollabDocument>) {
      const pageKey = pageKeyOf(doc.name);
      if (!pageKey) continue;
      for (const conn of doc.getConnections()) {
        const userId = conn.context?.user?.id;
        const workspaceId = conn.context?.user?.workspaceId;
        if (!userId || !workspaceId) continue; // not authenticated yet: onAuthenticate still decides it
        entries.push({ conn, userId, workspaceId, pageKey });
      }
    }
    if (entries.length === 0) return;

    const byUser = groupBy(entries, (e) => e.userId);
    await forEachLimited(
      [...byUser.values()],
      USER_CONCURRENCY,
      async (group) => {
        const { userId, workspaceId } = group[0];
        const user = await users.get(userId, workspaceId);
        const pages = new Map<
          string,
          Awaited<ReturnType<PageRepo['findById']>> | null | 'error'
        >();
        for (const key of new Set(group.map((e) => e.pageKey))) {
          try {
            pages.set(key, (await this.pageRepo.findById(key)) ?? null);
          } catch {
            pages.set(key, 'error');
          }
        }
        const checks = new CheckSet();
        for (const p of pages.values()) {
          if (!p || p === 'error') continue;
          checks.add('space', p.spaceId, ['administer', 'edit', 'view']);
          checks.add('page', p.id, ['view', 'edit', 'locked']);
        }
        const results =
          user === 'error' ? null : await checks.run(this.authz, userId);

        for (const e of group) {
          s.checked++;
          const page = pages.get(e.pageKey);
          let decision: CollabAccess;
          if (user === 'error' || page === 'error') {
            decision = 'unknown';
          } else {
            const space = page ? spacePerms(results, page.spaceId) : null;
            const pagePerms = page ? pagePermsOf(results, page.id) : null;
            // #524: only a page the PDP has not placed needs its lineage (the decision reads it only then).
            const lineage =
              page && pagePerms && !pagePerms.view && !pagePerms.locked
                ? await lineages.get(page.id)
                : undefined;
            decision = decideCollabAccess({
              user,
              page,
              space,
              pagePerms,
              lineageRestricted: lineage,
            });
          }
          this.actOnCollab(e.conn, decision, s);
        }
      },
    );
  }

  private actOnCollab(
    conn: LiveCollabConnection,
    decision: CollabAccess,
    s: LiveAccessSummary,
  ): void {
    if (decision === 'unknown') {
      s.unknown++;
      const run = bumpUnknown(this.unknownCollab.get(conn));
      this.unknownCollab.set(conn, run);
      if (!unknownExpired(run)) return;
      s.unknownClosed++;
    } else {
      this.unknownCollab.delete(conn);
      // Narrow only: `write` is a no-op, and so is `read` on a connection that is already read-only.
      if (decision === 'write' || (decision === 'read' && conn.readOnly))
        return;
    }
    conn.close(); // idempotent; the client re-authenticates on reconnect with a fresh decision
    s.closed++;
  }

  // ── socket.io (notifications / tree) ─────────────────────────────────────────────────────────────
  private async revalidateSockets(
    s: LiveAccessSummary,
    users: UserCache,
  ): Promise<void> {
    const sockets = this.ws.server?.of('/').sockets as
      | Map<string, LiveSocket>
      | undefined;
    if (!sockets || sockets.size === 0) return;
    const entries: {
      socket: LiveSocket;
      userId: string;
      workspaceId: string;
      spaceIds: string[];
    }[] = [];
    for (const socket of sockets.values()) {
      const userId = socket.data?.userId;
      const workspaceId = socket.data?.workspaceId;
      if (!userId || !workspaceId) continue; // still connecting: handleConnection decides it
      const spaceIds = [...socket.rooms]
        .filter((r) => r.startsWith(SPACE_ROOM_PREFIX))
        .map((r) => r.slice(SPACE_ROOM_PREFIX.length));
      entries.push({ socket, userId, workspaceId, spaceIds });
    }
    if (entries.length === 0) return;

    const byUser = groupBy(entries, (e) => e.userId);
    await forEachLimited(
      [...byUser.values()],
      USER_CONCURRENCY,
      async (group) => {
        const { userId, workspaceId } = group[0];
        const user = await users.get(userId, workspaceId);
        if (
          user !== 'error' &&
          (!user || user.deactivatedAt || user.deletedAt)
        ) {
          for (const e of group) {
            e.socket.disconnect(true);
            s.disconnected++;
          }
          return;
        }
        const checks = new CheckSet();
        for (const e of group)
          for (const id of e.spaceIds) checks.add('space', id, ['view']);
        const results =
          user === 'error' ? null : await checks.run(this.authz, userId);
        for (const e of group) {
          for (const spaceId of e.spaceIds) {
            s.checked++;
            const view = results?.get(checkKey('space', spaceId, 'view'));
            this.actOnRoom(e.socket, spaceId, view ?? null, s);
          }
        }
      },
    );
  }

  private actOnRoom(
    socket: LiveSocket,
    spaceId: string,
    view: boolean | null,
    s: LiveAccessSummary,
  ): void {
    let counts = this.unknownRooms.get(socket);
    if (view === true) {
      counts?.delete(spaceId);
      return;
    }
    if (view === null) {
      s.unknown++;
      if (!counts) this.unknownRooms.set(socket, (counts = new Map()));
      const run = bumpUnknown(counts.get(spaceId));
      counts.set(spaceId, run);
      if (!unknownExpired(run)) return;
      s.unknownClosed++;
    }
    counts?.delete(spaceId);
    socket.leave(`${SPACE_ROOM_PREFIX}${spaceId}`);
    s.left++;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** A run of consecutive unknown decisions for one connection (or socket room). */
interface UnknownRun {
  count: number;
  since: number;
}

const bumpUnknown = (run: UnknownRun | undefined): UnknownRun =>
  run
    ? { count: run.count + 1, since: run.since }
    : { count: 1, since: Date.now() };

/** Narrow only after BOTH bounds: enough passes, and enough time (see UNKNOWN_GRACE_MS). */
const unknownExpired = (run: UnknownRun): boolean =>
  run.count >= UNKNOWN_CAP && Date.now() - run.since >= UNKNOWN_GRACE_MS;

type UserRow = Awaited<ReturnType<UserRepo['findById']>>;

/** One user read per pass, shared by both planes. `'error'` = the read failed (unknown, never a deny). */
class UserCache {
  private readonly rows = new Map<string, Promise<UserRow | null | 'error'>>();
  constructor(private readonly repo: UserRepo) {}
  get(userId: string, workspaceId: string): Promise<UserRow | null | 'error'> {
    let p = this.rows.get(userId);
    if (!p) {
      p = this.repo.findById(userId, workspaceId).then(
        (u) => u ?? null,
        () => 'error' as const,
      );
      this.rows.set(userId, p);
    }
    return p;
  }
}

/** #524: one lineage read per page per pass (it does not depend on the user). `null` = the read failed (unknown,
 *  never a deny — the connect path denies on it, see collab-access.decision.ts). */
class LineageCache {
  private readonly rows = new Map<string, Promise<boolean | null>>();
  constructor(private readonly db: KyselyDB) {}
  get(pageId: string): Promise<boolean | null> {
    let p = this.rows.get(pageId);
    if (!p) {
      p = readPageLineage(this.db, pageId, { includeSelf: true }).then(
        lineageRestricted,
        () => null,
      );
      this.rows.set(pageId, p);
    }
    return p;
  }
}

const checkKey = (
  resourceType: string,
  resourceId: string,
  permission: string,
) => `${resourceType}:${resourceId}:${permission}`;

/** Deduplicated checks for one user, run as chunked `tryCheckBulk` calls. A failed chunk leaves its keys
 *  `null` (unknown) — never `false`. */
class CheckSet {
  private readonly items = new Map<string, AuthzCheckItem>();
  add(resourceType: string, resourceId: string, permissions: string[]): void {
    for (const permission of permissions) {
      this.items.set(checkKey(resourceType, resourceId, permission), {
        permission,
        resourceType,
        resourceId,
      });
    }
  }
  async run(
    authz: HttpAuthzClient,
    userId: string,
  ): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>();
    const entries = [...this.items.entries()];
    for (let i = 0; i < entries.length; i += CHECK_CHUNK) {
      const chunk = entries.slice(i, i + CHECK_CHUNK);
      const res = await authz.tryCheckBulk(
        { provider: 'docmost', externalId: userId },
        chunk.map(([, item]) => item),
      );
      chunk.forEach(([key], j) => out.set(key, res ? res[j] : null));
    }
    return out;
  }
}

function spacePerms(
  results: Map<string, boolean | null> | null,
  spaceId: string,
): SpacePermissions | null {
  if (!results) return null;
  const administer = results.get(checkKey('space', spaceId, 'administer'));
  const edit = results.get(checkKey('space', spaceId, 'edit'));
  const view = results.get(checkKey('space', spaceId, 'view'));
  if (administer == null || edit == null || view == null) return null;
  return { administer, edit, view };
}

function pagePermsOf(
  results: Map<string, boolean | null> | null,
  pageId: string,
): PagePermissions | null {
  if (!results) return null;
  const view = results.get(checkKey('page', pageId, 'view'));
  const edit = results.get(checkKey('page', pageId, 'edit'));
  const locked = results.get(checkKey('page', pageId, 'locked'));
  if (view == null || edit == null || locked == null) return null;
  return { view, edit, locked };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

async function forEachLimited<T>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}
