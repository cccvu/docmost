/**
 * CCC authorization integration — NOT upstream Docmost code (#781, ADR 0036).
 *
 * The collab update guard: refuses, BEFORE Hocuspocus applies it, a client frame that would make any browser's
 * y-tiptap delete content (its delete-on-error syncs to every peer), crash a render, or wedge the server's store; binds
 * each Yjs client id to the user who announced it or first wrote it as their own (an id first seen in another client's
 * relay of a lost lifetime's structs stays unbound until its author's awareness claims it); and keeps clients out of
 * every root but `'default'` (the `/v1` idempotency ledger, `__ccc_write_idem`, is server-only) and out of Stateless
 * broadcasts.
 *
 * How: each live Document gets a SHADOW replica (a second Y.Doc kept equal to live by a mirror listener). A frame is
 * applied to the shadow inside `Y.transact(shadow, …, origin, local=false)` — what y-protocols does to live — and
 * inspected inside that transaction, before Yjs's cleanup garbage-collects or merges anything: every struct from the
 * transaction's `beforeState` to the store's end, plus `tr.deleteSet`. So Yjs itself resolves parents, origins, splits
 * and pending structs. A refused frame leaves the shadow ahead of live, so the next frame rebuilds it from live plus the
 * frames accepted but not yet applied (`inflight`), keeping it an exact image of live's future.
 *
 * Ordering (Hocuspocus 4.7.1, `Connection.processMessages` and `MessageReceiver.apply`): each document connection
 * queues its frames and handles one at a time: it awaits the `beforeHandleMessage` hooks (one promise chain), then the
 * apply, which first awaits the `beforeSync` hooks (Sync frames) or the `beforeHandleAwareness` hooks (awareness
 * frames). So one connection's frames are strictly sequential, but frames of DIFFERENT connections interleave, and they
 * apply in the order this guard checked them only while every frame's path from check to apply has the same length and
 * waits on nothing but microtasks. Hence this guard is synchronous (returns undefined or throws, never a promise), runs
 * first, and is the only `beforeHandleMessage`, and the server defines no `beforeSync` or `beforeHandleAwareness` hook
 * (collab-update-guard.wiring.spec.ts). The in-flight list is still needed for that cross-connection interleaving.
 * Accepted frames have applied by the next macrotask: `setImmediate` clears the in-flight list. When a hook throws,
 * 4.x drops the frames that connection had queued (#1123), so a refused connection's later frames never reach here;
 * the guard still remembers the refusal and refuses any that do, as defense.
 *
 * Frame bounds (#790), in the same synchronous check, where Hocuspocus 4.7.1 leaves a gap: a SYNC BUDGET per (user,
 * document) and per user (a SyncStep1, and a reader's Step2, each make 4.7.1 encode or snapshot the whole document);
 * AWARENESS bounds for every connection, readers too (each state's size before anything parses it; a budget per (user, document) of
 * client ids new to the document; and no newer state for a client id bound to another user, so nobody can move
 * another user's cursor or selection; the name and colour in a state are the client's own say, never checked); and Auth
 * on an established
 * session or a message type 4.7.1's MessageReceiver does not handle (each one is otherwise handled without a limit, an
 * unhandled type with one unrate-limited console.error). The awareness RATE is not here: over-rate awareness frames are
 * dropped at the gateway (frame-address.ts), since a refusal here would end an honest editor's session.
 *
 * CPU bounds (#816), in the same check. The shadow apply runs inside the conflict-scan meter (conflict-scan.ts), which
 * replays Yjs's integrate walks before Yjs makes them and refuses the frame `conflict-scan` past a per-item or per-frame
 * step cap, before Yjs pays the walk; live never runs it. Two wire rules close the shapes the meter does not count: a
 * delete set whose ranges are not ascending (`delete-order`: each out-of-order range splits a struct near the front of
 * its client's array) and a keyed item with a rightOrigin (`attr-kind`: Yjs never writes one). Client ids live has
 * never seen are capped per frame (`client-ids`) and charged to the (user, document) id budget the awareness ids use:
 * every later transaction pays for every id a page holds. And a per-USER CPU budget, as a debt: each writer frame's
 * shadow step is timed and charged twice (live applies it again), and a frame that arrives while that user's balance is
 * negative closes the socket 1013 before any work. A rebuild a refusal made necessary is charged to the refused user.
 *
 * Refusal = a throw of `{ code: 4422, reason }`: Hocuspocus closes that ONE document session and sends the reason (the
 * websocket stays up). Reasons the client acts on (apps/client features/editor-ux): `ccc:collab-update-refused:<rule>`
 * (stop sending, read-only, notice) and `ccc:collab-update-unresolved` (reconnect once: a missing dependency, or new
 * clocks at an id whose owner has only announced it so far, logged `foreign-client` at stage `unproven-owner`). A
 * socket whose sessions are refused SOCKET_REFUSAL_BUDGET times is closed outright. An exhausted (user, document) budget is NOT a refusal: the
 * socket is closed 1013 (`tryLater`), which the editor retries. `COLLAB_UPDATE_GUARD=report` logs instead of either.
 */
import { Logger } from '@nestjs/common';
import * as decoding from 'lib0/decoding';
import { decodeUtf8 } from 'lib0/string';
import * as Y from 'yjs';
import { MessageType } from '@hocuspocus/server';
import { COLLAB_CONNECTIONS_PER_USER } from './limits';
import { ConflictScan, installConflictScanMeter, type ConflictScanMeter } from './conflict-scan';
import { collabSocketLimitLog, RateLimitedWarn, type SocketLimit, type SocketLimitLog } from './socket-limit-log';
import {
  checkAttribute,
  checkElement,
  checkFormat,
  checkValue,
  checkYTable,
  COLLAB_LIMITS,
  isElementName,
  type CollabRule,
  type ElementCheck,
  type Violation,
} from './content-rules';

export type CollabGuardMode = 'enforce' | 'report';
/** Kill switch, read once at load (like write-idem.ts): anything but `report` enforces. */
export const COLLAB_UPDATE_GUARD_MODE: CollabGuardMode = process.env.COLLAB_UPDATE_GUARD?.trim() === 'report' ? 'report' : 'enforce';
export const COLLAB_REFUSAL_CODE = 4422;
export const REFUSED_REASON_PREFIX = 'ccc:collab-update-refused:';
export const UNRESOLVED_REASON = 'ccc:collab-update-unresolved';
export const SOCKET_REFUSAL_BUDGET = 3;
/**
 * An honest connection announces one client id (y-protocols' Awareness keeps the id it was built with, even after Yjs
 * regenerates the doc's); this only bounds memory.
 */
const AWARENESS_BINDS_PER_CONNECTION = 32;
/** The ids one connection's own awareness announced that are remembered as its ownership evidence (memory bound only). */
const ANNOUNCED_PER_CONNECTION = AWARENESS_BINDS_PER_CONNECTION;
/**
 * Awareness-sourced binds per user per document, across that user's connections: past it awareness stops binding that
 * user's ids (never a refusal). Per user, so one writer cannot use up the binds every other user's ids need. An honest
 * user binds one id per editor they open on the page while it stays loaded (each page mount is a fresh Y.Doc).
 */
export const AWARENESS_BINDS_PER_USER = 256;
/**
 * #790 budgets per (user, document), kept across that user's connections and reconnects (a per-connection budget
 * refilled on every reconnect, so only the 1/s auth rate bounded it). Exhausting one closes the SOCKET with 1013 (Try
 * Again Later), which the editor waits out with its try-later backoff (5 s doubling to 60 s, jittered) before it
 * reconnects: never a 4422 refusal, which detaches the editor for good.
 *
 * Sync: SyncStep1 (Sync or SyncReply) and a read-only connection's Step2, each of which makes 4.7.1 encode or snapshot
 * the whole document. An honest provider sends one Step1 per open (HocuspocusProvider.onOpen; Docmost sets no
 * `forceSyncInterval`), and a reader one Step2 per open. The burst is two per connection of the per-user connection cap
 * (limits.ts), so all of a user's tabs on one page reconnecting at once after a deploy pass; then one per
 * SYNC_REFILL_MS (an editor reopened every 4 s, all day).
 */
export const SYNC_BURST = 2 * COLLAB_CONNECTIONS_PER_USER;
export const SYNC_REFILL_MS = 4_000;
/**
 * #790: the same sync frames per USER across all documents, charged together with the per-(user, document) budget, so
 * that opening a new page (a fresh per-document budget) does not buy another burst: the same burst (all 32 tabs
 * reconnecting after a deploy, each on its own page, pass), then one per USER_SYNC_REFILL_MS.
 */
export const USER_SYNC_BURST = 2 * COLLAB_CONNECTIONS_PER_USER;
export const USER_SYNC_REFILL_MS = 1_000;
/** #790: one awareness state's JSON, in UTF-8 bytes (an honest state is a user name, a colour and a cursor). */
export const AWARENESS_STATE_MAX_BYTES = 8 * 1024;
/**
 * #790: client ids new to the document's awareness (`awareness.meta`, which y-protocols never prunes while the document
 * is loaded; a removal of an unknown id adds one too), per (user, document) as above. An honest page mount adds one (two
 * if Yjs regenerates its id); the burst covers every tab of the per-user cap twice, then one per
 * AWARENESS_NEW_IDS_REFILL_MS.
 */
export const AWARENESS_NEW_IDS_BURST = 2 * COLLAB_CONNECTIONS_PER_USER;
export const AWARENESS_NEW_IDS_REFILL_MS = 4_000;
/** (user, document) budgets kept in this process; past it the least recently used is dropped (a fresh budget). */
export const USER_DOC_BUDGETS_MAX = 10_000;
/** #790: the socket close for an exhausted budget: 1013 (RFC 6455 Try Again Later), waited out by the editor's backoff. */
export const COLLAB_TRY_LATER_CODE = 1013;
export const TRY_LATER_REASON = 'ccc:collab-try-later';
/**
 * #816: struct client ids one frame may introduce that live has never seen (nor its awareness: an id is paid for once,
 * whichever announces it first). An honest frame introduces its own id, a Step2 from a page's local copy also those of
 * the browser's earlier sessions it still holds unsent. Each one stays in the page's state vector for good, and every
 * later transaction pays for every id the page holds. Past it the frame is refused `client-ids`; under it the ids are
 * charged to the (user, document) awareness-id budget (AWARENESS_NEW_IDS_*). Not above that burst, so a frame under the
 * ceiling always passes once the budget has refilled: it never loops on 1013.
 */
export const NEW_CLIENT_IDS_PER_FRAME = 64;
/**
 * #816: collab CPU per USER, across documents, as a debt. Every writer frame's work is timed from its pre-pass to its
 * last exit, refused or not, and charged in full: the pre-pass decode and a rebuild once, the shadow apply and its
 * inspection twice (live applies the frame again). A rebuild another user's refusal made necessary is charged to that
 * user. The balance does not refill while the charged work runs, and a charge is never clamped, so a frame costing T
 * leaves its sender about 20·T of wall clock in debt. A frame that arrives while the balance is negative closes the
 * socket 1013 before any work. So one large honest frame always passes, and one user's sustained share is about
 * USER_COLLAB_CPU_REFILL_MS_PER_SECOND per second (a tenth of a core, the burst aside), however large each frame is.
 * It bounds, in sustained use only, what the conflict-scan meter does not count (struct splits, formatting cleanup,
 * the element checks on a long list): never the first frame. Debt lives in the (user, document) LRU, so evicting the
 * user's entry (USER_DOC_BUDGETS_MAX others touched since) forgives it.
 */
export const USER_COLLAB_CPU_BURST_MS = 2_000;
export const USER_COLLAB_CPU_REFILL_MS_PER_SECOND = 100;
const CPU_MS_REFILL_EVERY_MS = 1_000 / USER_COLLAB_CPU_REFILL_MS_PER_SECOND;
const LOGS_PER_MINUTE = 30;

export const reasonFor = (rule: CollabRule): string => (rule === 'unresolved' ? UNRESOLVED_REASON : REFUSED_REASON_PREFIX + rule);

/**
 * The client message types 4.7.1's `MessageReceiver.apply` handles and an honest provider may send on an established
 * session (Stateless is refused on its own rule above, Auth on an established session on `auth`). Anything else falls
 * to its `default:` branch: one unrate-limited console.error per frame, and the session stays up.
 */
const HANDLED = new Set<number>([MessageType.Sync, MessageType.Awareness, MessageType.QueryAwareness, MessageType.SyncReply, MessageType.CLOSE]);
/** y-protocols/sync message subtypes (messageYjsSyncStep1/2/Update; y-protocols is not a declared dependency here). */
const STEP1 = 0;
const STEP2 = 1;
const UPDATE = 2;
/** The binding owner of the server's own client ids (live's, the shadow's): never a user id. */
const SERVER = '\u0000server';
const MIRROR = Symbol('ccc-collab-mirror');
const INSPECT = Symbol('ccc-collab-inspect');

export interface GuardLogger {
  warn(message: string): void;
}
export interface GuardConnection {
  readOnly: boolean;
  webSocket?: { close(code?: number, reason?: string): void };
}
/** The subset of Hocuspocus's `beforeHandleMessagePayload` the guard reads. */
export interface GuardFrame {
  connection: GuardConnection;
  /** Hocuspocus's Document: a Y.Doc with its page name and the awareness it has applied (`meta`: clientID → clock). */
  document: Y.Doc & { name?: string; awareness?: { meta: Map<number, { clock: number }> } };
  update: Uint8Array;
  context?: { user?: { id?: string } };
}
type Header = { type: number; subtype?: number; payload?: Uint8Array | null };
/** One awareness entry, its state still the undecoded UTF-8 JSON. */
type AwarenessEntry = { clientID: number; clock: number; state: Uint8Array };
/**
 * #816: what a refusal line may add: numbers and fixed words only, never a value from the frame. `unproven-owner`: a
 * `foreign-client` at an id whose owner has only announced it, answered `unresolved` (inspectTransaction).
 */
type RefusalLog = { steps?: number; stage?: 'conflict-scan' | 'unproven-owner' };
/** `proven`: awareness-bound ids the sender wrote new clocks at as their owner (no longer `awarenessOnly` once accepted). */
type ShadowResult = { violation: Violation | null; binds: Map<number, string>; proven?: Set<number>; applied: boolean; log?: RefusalLog };
type Ranges = Map<number, Array<[number, number]>>;

/** Per live Document: its shadow, client-id bindings and audit results. Dropped with the document (`destroy`). */
class DocGuard {
  shadow: Y.Doc | null = null;
  dirty = false;
  unavailable = false;
  audited = false;
  readonly bindings = new Map<number, string>();
  /** Elements the first build found invalid (legacy rows): reported, not refused. Ids survive rebuilds. */
  readonly legacyInvalid = new Set<string>();
  /** Pending structs the document was loaded with: a frame that releases them is not blamed for them. */
  legacyPending: Ranges = new Map();
  readonly inflight: Uint8Array[] = [];
  flushScheduled = false;
  readonly awarenessBinds = new WeakMap<object, number>();
  /** Awareness-sourced binds on this document per user, across that user's connections (AWARENESS_BINDS_PER_USER). */
  readonly awarenessBindsByUser = new Map<string, number>();
  /**
   * Per writer connection: the client ids its OWN awareness announced (a non-null state that is not an echo, or one
   * for an id already bound to its user), whether or not the announcement bound the id. The evidence a struct bind
   * needs (inspectTransaction). Absent = announced nothing.
   */
  readonly announced = new WeakMap<object, Set<number>>();
  /**
   * Ids bound by awareness whose owner has written no struct at a new clock in this lifetime. New clocks there from
   * another user are answered `unresolved`, not refused (the owner's own Step2 may not have landed yet: the mirror race).
   */
  readonly awarenessOnly = new Set<number>();
  /** The client id bound to SERVER for the current shadow: unbound again when a rebuild replaces that shadow. */
  shadowBinding: number | null = null;
  /** #816: the user whose refused frame left the shadow dirty: the rebuild is charged to them, not the next sender. */
  dirtiedBy: string | null = null;
  constructor(readonly live: Y.Doc & { name?: string }) {}
}

type Bucket = { tokens: number; at: number };
/** `cpu` (milliseconds, #816) is only used on the whole-user entry. */
type UserDocBudget = { sync: Bucket; ids: Bucket; cpu: Bucket };

export class CollabUpdateGuard {
  private readonly docs = new WeakMap<Y.Doc, DocGuard>();
  private readonly refusedConnections = new WeakMap<object, string>();
  private readonly socketRefusals = new WeakMap<object, number>();
  /** #790: per (user, document) budgets, least recently used first; and per connection, the ids it already paid for. */
  private readonly userDocBudgets = new Map<string, UserDocBudget>();
  private readonly awarenessNewIds = new WeakMap<object, Set<number>>();
  private readonly mode: CollabGuardMode;
  private readonly logger: GuardLogger;
  private readonly limitLog: SocketLimitLog;
  private readonly now: () => number;
  /** Guard lines, LOGS_PER_MINUTE per token a minute; the rest are counted (socket-limit-log.ts, #810). */
  private readonly logLines = new RateLimitedWarn<string>({
    logger: { warn: (message) => this.logger.warn(message) },
    perKey: LOGS_PER_MINUTE,
    summary: (token, count) => `COLLAB_GUARD_LOG_SUPPRESSED ${JSON.stringify({ of: token, count })}`,
  });
  private readonly cpuNow: () => number;
  private readonly meter: ConflictScanMeter;

  constructor(
    opts: { mode?: CollabGuardMode; logger?: GuardLogger; limitLog?: SocketLimitLog; now?: () => number; cpuNow?: () => number } = {},
  ) {
    this.mode = opts.mode ?? COLLAB_UPDATE_GUARD_MODE;
    this.logger = opts.logger ?? new Logger('CollabUpdateGuard');
    this.limitLog = opts.limitLog ?? collabSocketLimitLog;
    this.now = opts.now ?? Date.now;
    this.cpuNow = opts.cpuNow ?? (() => performance.now());
    // Throws when yjs changed shape, so the server refuses to boot rather than run unbounded (#816).
    this.meter = installConflictScanMeter(Y);
  }

  /** Synchronous: returns undefined (apply the frame) or throws `{ code, reason }` (refuse it). Never a promise. */
  check(frame: GuardFrame): void {
    const earlier = this.refusedConnections.get(frame.connection);
    if (earlier) throw { code: COLLAB_REFUSAL_CODE, reason: earlier };
    const header = readHeader(frame.update);
    if (!header) return; // not decodable as a frame: Hocuspocus refuses it itself
    if (header.type === MessageType.Stateless || header.type === MessageType.BroadcastStateless) {
      return this.refuse(frame, header, { rule: 'stateless' }); // nothing in Docmost sends one; a broadcast reaches every peer
    }
    // Only an established session's frames reach this hook (Hocuspocus consumes the Auth that establishes it): a second
    // Auth re-runs onTokenSync, or logs, per frame. An honest provider authenticates once per open.
    if (header.type === MessageType.Auth) return this.refuse(frame, header, { rule: 'auth' });
    if (!HANDLED.has(header.type)) return this.refuse(frame, header, { rule: 'message-type' });
    if (header.type === MessageType.Awareness) {
      if (!header.payload) return; // malformed: Hocuspocus refuses it itself
      const checked = this.checkAwareness(frame, header.payload);
      if (checked.violation) this.refuse(frame, header, checked.violation); // throws unless report mode
      if (checked.fresh.size) {
        const budget = this.budgetFor(frame);
        if (!this.take(budget.ids, AWARENESS_NEW_IDS_BURST, AWARENESS_NEW_IDS_REFILL_MS, checked.fresh.size)) {
          this.tryLater(frame, 'user_awareness_ids'); // throws unless report mode
        }
        const introduced = this.awarenessNewIds.get(frame.connection) ?? new Set<number>();
        for (const id of checked.fresh) introduced.add(id);
        this.awarenessNewIds.set(frame.connection, introduced);
      }
      // Hocuspocus relays a reader's awareness too, so only a writer's binds: a reader could otherwise claim a writer's id.
      if (!frame.connection.readOnly && checked.entries) this.bindFromAwareness(this.docFor(frame.document), frame, checked.entries);
      return;
    }
    if (header.type !== MessageType.Sync && header.type !== MessageType.SyncReply) return;
    // A Step1 makes Hocuspocus encode the whole document (its Step2 answer); a reader's Step2 makes it snapshot it.
    if (header.subtype === STEP1 || (header.subtype === STEP2 && frame.connection.readOnly)) {
      const ok = this.takeBoth(
        [this.budgetFor(frame, true).sync, USER_SYNC_BURST, USER_SYNC_REFILL_MS],
        [this.budgetFor(frame).sync, SYNC_BURST, SYNC_REFILL_MS],
      );
      if (!ok) this.tryLater(frame, 'user_sync_budget');
      return;
    }
    if (header.subtype !== STEP2 && header.subtype !== UPDATE) return; // Hocuspocus refuses an unknown subtype itself
    if (frame.connection.readOnly) return; // Hocuspocus never applies a read-only connection's update (it only nacks it)
    if (!header.payload) return this.refuse(frame, header, { rule: 'undecodable' });
    this.inspect(frame, header, header.payload);
  }

  /** The shadow replica of `live` (specs and diagnostics). */
  shadowOf(live: Y.Doc): Y.Doc | null {
    return this.docs.get(live)?.shadow ?? null;
  }

  /** How many client ids are bound on `live` (specs and diagnostics). */
  bindingCount(live: Y.Doc): number {
    return this.docs.get(live)?.bindings.size ?? 0;
  }

  /** How many (user, document) budgets are kept (specs and diagnostics). */
  budgetCount(): number {
    return this.userDocBudgets.size;
  }

  /** The (user, document) budget of this frame's connection, made most recently used; the least recent past the cap goes. */
  private budgetFor(frame: GuardFrame, wholeUser = false): UserDocBudget {
    return this.budgetOf(String(frame.context?.user?.id ?? ''), wholeUser ? null : (frame.document.name ?? ''));
  }

  /** The budget of (`user`, `docName`), or the whole user's when `docName` is null. */
  private budgetOf(user: string, docName: string | null): UserDocBudget {
    const wholeUser = docName === null;
    const key = wholeUser ? `${user}\u0001` : `${user}\u0000${docName}`;
    const at = this.now();
    let budget = this.userDocBudgets.get(key);
    if (budget) this.userDocBudgets.delete(key);
    else {
      budget = {
        sync: { tokens: wholeUser ? USER_SYNC_BURST : SYNC_BURST, at },
        ids: { tokens: AWARENESS_NEW_IDS_BURST, at },
        cpu: { tokens: USER_COLLAB_CPU_BURST_MS, at },
      };
    }
    this.userDocBudgets.set(key, budget);
    if (this.userDocBudgets.size > USER_DOC_BUDGETS_MAX) this.userDocBudgets.delete(this.userDocBudgets.keys().next().value!);
    return budget;
  }

  /** One token from each bucket, or none from either. */
  private takeBoth(...buckets: Array<[Bucket, number, number]>): boolean {
    const now = this.now();
    for (const [bucket, burst, refillMs] of buckets) {
      bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) / refillMs);
      bucket.at = now;
    }
    if (buckets.some(([bucket]) => bucket.tokens < 1)) return false;
    for (const [bucket] of buckets) bucket.tokens -= 1;
    return true;
  }

  /** Take `n` tokens from `bucket` (`burst`, refilled one per `refillMs`); false, taking none, when it holds fewer. */
  private take(bucket: Bucket, burst: number, refillMs: number, n: number): boolean {
    this.refill(bucket, burst, refillMs);
    if (bucket.tokens < n) return false;
    bucket.tokens -= n;
    return true;
  }

  private refill(bucket: Bucket, burst: number, refillMs: number): void {
    const now = this.now();
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) / refillMs);
    bucket.at = now;
  }

  /**
   * #816: charge `ms` of collab CPU to `user`, all of it, into debt if need be. The balance refills up to `workStarted`
   * (wall clock) and not while the charged work ran: the event loop was that work's, so it earns nothing back.
   */
  private chargeCpu(user: string, ms: number, workStarted: number): void {
    const bucket = this.budgetOf(user, null).cpu;
    const now = this.now();
    bucket.tokens = Math.min(USER_COLLAB_CPU_BURST_MS, bucket.tokens + Math.max(0, Math.min(now, workStarted) - bucket.at) / CPU_MS_REFILL_EVERY_MS);
    bucket.at = Math.max(bucket.at, now);
    bucket.tokens -= Math.max(0, ms);
  }

  /** A user's collab CPU balance now, in ms (specs and diagnostics): a full burst when none is kept. Touches nothing. */
  cpuBalance(user: string): number {
    const bucket = this.userDocBudgets.get(`${user}\u0001`)?.cpu;
    if (!bucket) return USER_COLLAB_CPU_BURST_MS;
    return Math.min(USER_COLLAB_CPU_BURST_MS, bucket.tokens + Math.max(0, this.now() - bucket.at) / CPU_MS_REFILL_EVERY_MS);
  }

  /**
   * An exhausted (user, document) budget: close the SOCKET with 1013 first (so Hocuspocus's document CLOSE, sent next,
   * is dropped by the closing socket and the editor sees only a retryable socket close), then throw so this frame and
   * the ones queued behind it are not applied. Logged `COLLAB_SOCKET_LIMIT`, rate-limited. Report mode only logs.
   */
  private tryLater(frame: GuardFrame, limit: SocketLimit): void {
    this.limitLog.log(limit, { userId: String(frame.context?.user?.id ?? '') });
    if (this.mode === 'report') return;
    try {
      frame.connection.webSocket?.close(COLLAB_TRY_LATER_CODE, TRY_LATER_REASON);
    } catch {
      // already closing
    }
    throw { code: COLLAB_TRY_LATER_CODE, reason: TRY_LATER_REASON };
  }


  /**
   * The awareness bounds, for every connection. Each state's size is read from its length prefix and checked before
   * anything decodes or parses it (Hocuspocus then JSON.parses every state, twice). Entries per frame are not capped (a
   * provider's timeout removal can carry the whole room), but a client id twice in one frame is never honest. The ids
   * the document's awareness has never held (`fresh`, not counting ids this connection already paid for) are charged to
   * the sender's (user, document) budget by the caller.
   *
   * A state for a client id bound to ANOTHER user (by its structs or its own awareness) is refused `foreign-client`:
   * the sender would replace that user's cursor and selection (and the name and colour shown with them) for every
   * peer. The name and colour in a sender's OWN state are its own say: nothing checks them. Two kinds of entry about
   * another user's id are honest and pass: a removal (state `null`: a provider's `timeout` removal of a peer that went
   * quiet), and an echo at a clock the server already holds (a 3.x provider resending what it was relayed), which
   * y-protocols ignores anyway.
   */
  private checkAwareness(
    frame: GuardFrame,
    payload: Uint8Array,
  ): { violation: Violation | null; entries: AwarenessEntry[] | null; fresh: Set<number> } {
    const entries: AwarenessEntry[] = [];
    const meta = frame.document.awareness?.meta;
    const bindings = this.docs.get(frame.document)?.bindings;
    const userId = String(frame.context?.user?.id ?? '');
    const introduced = this.awarenessNewIds.get(frame.connection) ?? new Set<number>();
    const fresh = new Set<number>();
    const seen = new Set<number>();
    const refused = { violation: { rule: 'awareness' } as Violation, entries: null, fresh };
    try {
      const d = decoding.createDecoder(payload);
      const n = decoding.readVarUint(d);
      for (let i = 0; i < n; i++) {
        const clientID = decoding.readVarUint(d);
        const clock = decoding.readVarUint(d);
        const length = decoding.readVarUint(d); // the state's JSON, in UTF-8 bytes
        if (length > AWARENESS_STATE_MAX_BYTES || d.pos + length > payload.length) return refused;
        const state = payload.subarray(d.pos, d.pos + length);
        d.pos += length;
        if (seen.has(clientID)) return refused;
        seen.add(clientID);
        const owner = bindings?.get(clientID);
        if (owner !== undefined && owner !== userId && !isNullState(state)) {
          const held = meta?.get(clientID)?.clock;
          if (held === undefined || clock > held) return { violation: { rule: 'foreign-client' }, entries: null, fresh };
        }
        if (!meta?.has(clientID) && !introduced.has(clientID)) fresh.add(clientID);
        entries.push({ clientID, clock, state });
      }
    } catch {
      return { violation: null, entries: null, fresh: new Set() }; // malformed: Hocuspocus refuses it itself
    }
    return { violation: null, entries, fresh };
  }

  private inspect(frame: GuardFrame, header: Header, payload: Uint8Array): void {
    const doc = this.docFor(frame.document);
    const userId = String(frame.context?.user?.id ?? '');
    // 0. #816: a user in CPU debt waits, before any work.
    if (!this.take(this.budgetFor(frame, true).cpu, USER_COLLAB_CPU_BURST_MS, CPU_MS_REFILL_EVERY_MS, 0)) {
      this.tryLater(frame, 'user_collab_cpu'); // throws unless report mode
    }
    // From here every exit is charged (#816): the pre-pass and any rebuild once, the shadow apply twice (live applies the
    // frame again). A rebuild someone else's refusal made necessary is theirs.
    const workStarted = this.now();
    const started = this.cpuNow();
    let othersMs = 0;
    let applyMs = 0;
    try {
      // 1. Stateless pre-pass: a refusal here touches no shadow, so a refuse/reconnect loop costs no rebuild.
      const pre = prePass(payload);
      let violation = pre.violation;
      if (violation && this.mode === 'enforce') return this.refuse(frame, header, violation);
      // 1b. #816: client ids live has never seen, charged before anything integrates them.
      violation ??= this.chargeNewClientIds(frame, pre.clients);
      if (violation && this.mode === 'enforce') return this.refuse(frame, header, violation);
      // 2. The shadow step.
      const blame = doc.dirty && doc.dirtiedBy !== null && doc.dirtiedBy !== userId ? doc.dirtiedBy : null;
      const rebuildStarted = blame === null ? 0 : this.cpuNow();
      const rebuildWallStarted = blame === null ? 0 : this.now();
      const ready = this.ensureShadow(doc);
      if (blame !== null) {
        othersMs = this.cpuNow() - rebuildStarted;
        this.chargeCpu(blame, othersMs, rebuildWallStarted); // shadow-only work: once
      }
      if (!ready) return this.refuse(frame, header, violation ?? { rule: 'shadow-unavailable' });
      const applyStarted = this.cpuNow();
      const result = this.applyToShadow(doc, payload, userId, ownedBy(doc.announced.get(frame.connection)));
      applyMs = this.cpuNow() - applyStarted;
      violation ??= result.violation;
      if (violation && this.mode === 'enforce') {
        // The shadow holds the refused frame; live never will. Rebuilt lazily by the next frame that needs it
        // (ensureShadow), so a refuse/reconnect loop pays no rebuild per refusal, and that rebuild is this user's.
        doc.dirty = true;
        doc.dirtiedBy = userId;
        return this.refuse(frame, header, violation, result.log);
      }
      if (violation) this.refuse(frame, header, violation, result.log); // report mode: logged, and the frame applies
      for (const [client, user] of result.binds) if (!doc.bindings.has(client)) doc.bindings.set(client, user);
      for (const client of result.proven ?? []) doc.awarenessOnly.delete(client);
      // A frame the shadow could not apply is not replayed into a rebuild (it would fail every rebuild from then on).
      if (result.applied) doc.inflight.push(payload.slice());
      this.scheduleFlush(doc);
    } finally {
      this.chargeCpu(userId, this.cpuNow() - started - othersMs + applyMs, workStarted);
    }
  }

  /**
   * #816: the frame's struct client ids that live has never seen, its awareness does not hold and this connection has
   * not already paid for: past NEW_CLIENT_IDS_PER_FRAME a refusal, under it charged to the (user, document) id budget.
   */
  private chargeNewClientIds(frame: GuardFrame, clients: Set<number>): Violation | null {
    const live = frame.document;
    const meta = live.awareness?.meta;
    const introduced = this.awarenessNewIds.get(frame.connection) ?? new Set<number>();
    const fresh: number[] = [];
    for (const client of clients) {
      if (Y.getState(live.store, client) === 0 && !meta?.has(client) && !introduced.has(client)) fresh.push(client);
    }
    if (!fresh.length) return null;
    if (fresh.length > NEW_CLIENT_IDS_PER_FRAME) return { rule: 'client-ids' };
    if (!this.take(this.budgetFor(frame).ids, AWARENESS_NEW_IDS_BURST, AWARENESS_NEW_IDS_REFILL_MS, fresh.length)) {
      this.tryLater(frame, 'user_client_ids'); // throws unless report mode
    }
    for (const id of fresh) introduced.add(id);
    this.awarenessNewIds.set(frame.connection, introduced);
    return null;
  }

  /**
   * The frame applied to the shadow inside the conflict-scan meter (#816). A trip or a meter failure throws out of
   * Yjs's stack, before the item it was replaying integrates; the scope says which, never the error's identity.
   */
  private applyToShadow(doc: DocGuard, payload: Uint8Array, userId: string, own: (client: number) => boolean): ShadowResult {
    const shadow = doc.shadow!;
    const pendingBefore = pendingRanges(shadow.store);
    const scan = new ConflictScan(shadow, this.mode === 'enforce');
    let out: ShadowResult = { violation: { rule: 'internal' }, binds: new Map(), applied: false };
    try {
      this.meter.metered(scan, () =>
        Y.transact(
          shadow,
          (tr) => {
            Y.applyUpdate(shadow, payload, INSPECT); // V1, as y-protocols reads Step2 and Update
            out = this.inspectTransaction(doc, tr, userId, own, pendingBefore);
          },
          INSPECT,
          false,
        ),
      );
    } catch {
      doc.dirty = true;
      doc.dirtiedBy = userId;
      if (scan.trip !== null) {
        return { violation: { rule: 'conflict-scan' }, binds: new Map(), applied: false, log: { steps: scan.trip.steps } };
      }
      const log: RefusalLog | undefined = scan.failure !== null ? { stage: 'conflict-scan' } : undefined;
      return { violation: { rule: 'internal' }, binds: new Map(), applied: false, log };
    }
    // Report mode: the meter counted past the cap and threw nothing; the frame is logged as it would have been refused.
    if (scan.trip !== null) return { ...out, violation: { rule: 'conflict-scan' }, log: { steps: scan.steps } };
    return out;
  }

  /** Inside the transaction, after the frame integrated and before any GC or merge. */
  private inspectTransaction(doc: DocGuard, tr: Y.Transaction, userId: string, own: (client: number) => boolean, pendingBefore: Ranges) {
    const shadow = tr.doc;
    const store = shadow.store;
    const root = shadow.share.get('default');
    const touched = new Set<Y.AbstractType<any>>();
    const newTypes: Y.AbstractType<any>[] = [];
    const binds = new Map<number, string>();
    const proven = new Set<number>();
    const reportOnly: Violation[] = [];
    const result = (violation: Violation | null, log?: RefusalLog): ShadowResult => ({ violation, binds, proven, applied: true, ...(log ? { log } : {}) });

    for (const [client, structs] of store.clients) {
      const before = tr.beforeState.get(client) ?? 0;
      if (Y.getState(store, client) <= before) continue;
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        const legacy = inRanges(doc.legacyPending, client, struct.id.clock, struct.length);
        if (!legacy) {
          // Client-id binding, on NEW clocks only: a remount honestly resends a peer's structs live already has.
          const owner = doc.bindings.get(client) ?? binds.get(client);
          if (owner === undefined) {
            // Only an id live never saw binds here. An id the stored document already holds (an earlier lifetime) binds
            // by awareness only: bindings are not persisted, so a claim on it after a reload is undetectable (ADR 0036).
            // And only to a sender whose connection announced it, or announced nothing (a pagehide-nulled awareness, a
            // promoted reader: the rule before this evidence existed). Any other never-seen id is another client's
            // structs relayed from a lifetime that lost them: it stays unbound, so its author's awareness claims it.
            if (!tr.beforeState.has(client) && own(client)) binds.set(client, userId);
          } else if (owner !== userId) {
            // The owner has only announced the id so far: its own Step2 may still be on the way while a peer relays its
            // lost structs (the mirror race after a lost lifetime). Never applied either way; `unresolved` makes the
            // sender reconnect once. That recovers a ONE-SIDED relay, and only when the owner's Step2 lands before the
            // retry (an owner round trip under about twice the relayer's). Residual (ADR 0036 §4): when co-editors' frames
            // each carry another's unproven id, none lands and none proves, so each is unresolved twice, which is final.
            if (doc.awarenessOnly.has(client)) return result({ rule: 'foreign-client' }, { stage: 'unproven-owner' });
            return result({ rule: 'foreign-client' });
          } else if (doc.awarenessOnly.has(client)) {
            proven.add(client);
          }
        }
        if (!(struct instanceof Y.Item)) continue; // GC: no content, no parent
        const v = checkStruct(struct, root, touched, newTypes);
        if (v && legacy) reportOnly.push(v);
        else if (v) return result(v);
      }
    }
    for (const type of newTypes) if (depthOf(type) > COLLAB_LIMITS.elementDepth) return result({ rule: 'element-depth' });

    let deletion: Violation | null = null;
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (deletion || !(struct instanceof Y.Item)) return;
      if (rootOf(struct.parent as Y.AbstractType<any>) !== root) {
        deletion = { rule: 'root' };
        return;
      }
      touch(struct, touched);
    });
    if (deletion) return result(deletion);

    for (const type of touched) {
      if (type !== root && kindOf(type) !== 'element') continue;
      if (!isVisible(type)) continue;
      const check = checkElement(type as Y.XmlElement);
      if (check.ok || check.empty) continue; // an emptied container loses nothing (see content-rules.ts)
      if (doc.legacyInvalid.has(idOf(type))) continue; // invalid before this frame, already deleted on every open
      return result(check.violation);
    }
    // A table's extent is a property of the whole table: a changed cell span, row or cell can widen it.
    const tables = new Set<Y.XmlElement>();
    for (const type of touched) {
      const table = enclosingTable(type);
      if (table && isVisible(table) && !doc.legacyInvalid.has(idOf(table))) tables.add(table);
    }
    for (const table of tables) {
      const v = checkYTable(table);
      if (v) return result(v);
    }
    // Structs that wait for a missing dependency would integrate later, unchecked and blamed on whoever sends it.
    if (!covers(pendingBefore, pendingRanges(store))) return result({ rule: 'unresolved' });
    for (const v of reportOnly) this.log('COLLAB_LEGACY_PENDING_INVALID', doc.live, { rule: v.rule });
    return result(null);
  }

  private docFor(live: Y.Doc & { name?: string }): DocGuard {
    const known = this.docs.get(live);
    if (known) return known;
    const created = new DocGuard(live);
    created.bindings.set(live.clientID, SERVER);
    // The mirror NEVER throws: a throw in a Yjs 'update' listener stops every later listener and wedges the document's
    // cleanup for good. On any failure the shadow is only marked dirty (the next frame rebuilds it).
    const mirror = (update: Uint8Array) => {
      const shadow = created.shadow;
      if (!shadow || created.dirty) return;
      try {
        Y.applyUpdate(shadow, update, MIRROR);
      } catch {
        created.dirty = true;
      }
    };
    live.on('update', mirror);
    live.once('destroy', () => {
      live.off('update', mirror);
      created.shadow = null;
      this.docs.delete(live);
    });
    this.docs.set(live, created);
    return created;
  }

  private ensureShadow(doc: DocGuard): boolean {
    if (doc.unavailable) return false;
    if (doc.shadow && !doc.dirty && statesCover(doc.shadow.store, doc.live.store)) return true;
    return this.rebuild(doc);
  }

  /** The shadow from live plus the frames accepted but not yet applied: exactly what live will hold. */
  private rebuild(doc: DocGuard): boolean {
    if (doc.unavailable) return false;
    const live = doc.live;
    try {
      const shadow = new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter });
      shadow.getXmlFragment('default');
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(live), MIRROR);
      for (const frame of doc.inflight) Y.applyUpdate(shadow, frame, MIRROR);
      doc.shadow = shadow;
      doc.dirty = false;
      doc.dirtiedBy = null;
      // The replaced shadow is gone, and so is any reason to reserve its client id: one binding per rebuild otherwise.
      const replaced = doc.shadowBinding;
      if (replaced !== null && replaced !== live.clientID && doc.bindings.get(replaced) === SERVER) doc.bindings.delete(replaced);
      doc.shadowBinding = null;
      if (!doc.bindings.has(shadow.clientID)) {
        doc.bindings.set(shadow.clientID, SERVER);
        doc.shadowBinding = shadow.clientID;
      }
      if (!doc.audited) this.audit(doc, shadow);
      return true;
    } catch {
      // A live document Yjs cannot encode (a legacy value too deep for lib0's encoder): fail closed, logged once.
      doc.unavailable = true;
      doc.shadow = null;
      this.logger.warn(`COLLAB_SHADOW_UNAVAILABLE ${JSON.stringify({ pageId: pageIdOf(live) })}`);
      return false;
    }
  }

  /** First build only: a report-only audit of the stored content (legacy rows), at no extra cost. */
  private audit(doc: DocGuard, shadow: Y.Doc): void {
    doc.audited = true;
    doc.legacyPending = pendingRanges(shadow.store);
    const rules: Record<string, number> = {};
    const root = shadow.getXmlFragment('default');
    /** Elements every browser's y-tiptap deletes on open (invalid, or emptied and then invalid). */
    const gone = new Set<Y.AbstractType<any>>();
    const stack: Array<[Y.AbstractType<any>, number]> = [[root, 0]];
    while (stack.length) {
      const [type, depth] = stack.pop()!;
      const check: ElementCheck = depth > COLLAB_LIMITS.elementDepth ? { ok: false, violation: { rule: 'element-depth' }, empty: false } : checkElement(type as Y.XmlElement);
      if (!check.ok && type !== root) gone.add(type);
      const tableSize = type !== root && (type as Y.XmlElement).nodeName === 'table' ? checkYTable(type as Y.XmlElement) : null;
      if (tableSize && check.ok) {
        doc.legacyInvalid.add(idOf(type)); // a legacy table past the extent bound: reported, its edits not refused for it
        rules['table-size'] = (rules['table-size'] ?? 0) + 1;
      }
      if (!check.ok && !check.empty) {
        doc.legacyInvalid.add(idOf(type));
        rules[check.violation.rule] = (rules[check.violation.rule] ?? 0) + 1;
      }
      for (let item = type._start; item !== null; item = item.right) {
        if (!item.deleted && item.content instanceof Y.ContentType && kindOf(item.content.type) === 'element') {
          stack.push([item.content.type, depth + 1]);
        }
      }
    }
    // y-tiptap's cascade: deleting an invalid element can leave its parent invalid, and every browser then deletes the
    // parent too, one transaction (one frame) per element. Each parent left invalid and non-empty is legacy as well, so
    // the deletes of every browser that opens the page are accepted, never refused on every open.
    const queue = [...gone];
    while (queue.length) {
      const parent = queue.pop()!._item?.parent as Y.AbstractType<any> | undefined;
      if (!parent || gone.has(parent) || !isVisible(parent)) continue;
      const check = checkElement(parent as Y.XmlElement, gone);
      if (check.ok) continue;
      if (!check.empty) {
        doc.legacyInvalid.add(idOf(parent));
        rules[`cascade:${check.violation!.rule}`] = (rules[`cascade:${check.violation!.rule}`] ?? 0) + 1;
      }
      if (parent !== root) {
        gone.add(parent);
        queue.push(parent);
      }
    }
    if (doc.legacyInvalid.size) {
      this.logger.warn(`COLLAB_STORED_CONTENT_INVALID ${JSON.stringify({ pageId: pageIdOf(doc.live), elements: doc.legacyInvalid.size, rules })}`);
    }
  }

  private scheduleFlush(doc: DocGuard): void {
    if (doc.flushScheduled) return;
    doc.flushScheduled = true;
    setImmediate(() => {
      doc.flushScheduled = false;
      doc.inflight.length = 0;
      // Every accepted frame has applied by now. A shadow still ahead of live means one did not: rebuild before trusting it.
      const shadow = doc.shadow;
      if (shadow && !statesCover(doc.live.store, shadow.store)) doc.dirty = true;
    });
  }

  /**
   * A writer's awareness entries (already within checkAwareness's bounds) bind the client ids they announce, and record
   * them as the connection's ownership evidence (DocGuard.announced).
   */
  private bindFromAwareness(doc: DocGuard, frame: GuardFrame, entries: AwarenessEntry[]): void {
    const userId = String(frame.context?.user?.id ?? '');
    try {
      for (const { clientID, clock, state } of entries) {
        const owner = doc.bindings.get(clientID);
        if (owner !== undefined && owner !== userId) continue; // another user's (an echo or a removal: checkAwareness)
        // An echo (a provider's `timeout` removal of a peer, or a 3.x provider resending what it was relayed): the server
        // already holds this client's state at this clock (it relayed it), so the echo says nothing about who owns the
        // id: a writer's echo of a READER's state would otherwise bind the reader's id to the writer, refusing the reader
        // once promoted. An echo of an id already bound to this user (a reconnect resending its own state) still
        // announces it.
        const held = frame.document.awareness?.meta.get(clientID)?.clock;
        if (owner === undefined && held !== undefined && held >= clock) continue;
        if (JSON.parse(decodeUtf8(state)) === null) continue; // at most AWARENESS_STATE_MAX_BYTES
        // Ownership evidence for this connection's struct binds, recorded whether or not the id binds below (past a
        // bind budget the sender's own id is still its own).
        const announced = doc.announced.get(frame.connection) ?? new Set<number>();
        if (announced.size < ANNOUNCED_PER_CONNECTION) announced.add(clientID);
        doc.announced.set(frame.connection, announced);
        if (owner !== undefined) continue;
        const used = doc.awarenessBinds.get(frame.connection) ?? 0;
        const byUser = doc.awarenessBindsByUser.get(userId) ?? 0;
        if (used >= AWARENESS_BINDS_PER_CONNECTION || byUser >= AWARENESS_BINDS_PER_USER) continue;
        doc.bindings.set(clientID, userId);
        doc.awarenessOnly.add(clientID);
        doc.awarenessBinds.set(frame.connection, used + 1);
        doc.awarenessBindsByUser.set(userId, byUser + 1);
      }
    } catch {
      // a state that is not JSON: Hocuspocus refuses the frame itself
    }
  }

  /** Logs the refusal; in enforce mode also closes the session (throws) and counts against the socket's budget. */
  private refuse(frame: GuardFrame, header: Header, violation: Violation, extra?: RefusalLog): void {
    // An unproven owner's id: logged as the foreign-client it is, answered as a reconnect (inspectTransaction).
    const reason = extra?.stage === 'unproven-owner' ? UNRESOLVED_REASON : reasonFor(violation.rule);
    this.log('COLLAB_UPDATE_REFUSED', frame.document, {
      rule: violation.rule,
      ...(violation.node ? { node: violation.node } : {}),
      ...(violation.mark ? { mark: violation.mark } : {}),
      ...(violation.key ? { key: violation.key } : {}),
      ...extra, // #816: `steps` for conflict-scan, `stage` for a meter failure; numbers and fixed words only
      userId: frame.context?.user?.id,
      msgType: header.type,
      ...(header.subtype !== undefined ? { syncType: header.subtype } : {}),
      bytes: frame.update.length,
      mode: this.mode,
    });
    if (this.mode !== 'enforce') return;
    this.refusedConnections.set(frame.connection, reason);
    const ws = frame.connection.webSocket;
    if (ws) {
      const refusals = (this.socketRefusals.get(ws) ?? 0) + 1;
      this.socketRefusals.set(ws, refusals);
      if (refusals >= SOCKET_REFUSAL_BUDGET) {
        try {
          ws.close(COLLAB_REFUSAL_CODE, reason);
        } catch {
          // already closing
        }
      }
    }
    throw { code: COLLAB_REFUSAL_CODE, reason };
  }

  /** Rate-limited structured warn lines, per token. Schema ids, user and page ids only: never a value or any content. */
  private log(token: string, live: Y.Doc & { name?: string }, fields: Record<string, unknown>): void {
    this.logLines.warn(token, () => `${token} ${JSON.stringify({ ...fields, pageId: pageIdOf(live) })}`);
  }
}

/**
 * May a struct at a never-seen id bind it to this connection's user? Yes when its own awareness announced that id, or
 * announced none (the rule before this evidence: a sender that sends no awareness still gets it, ADR 0036 §4). An honest
 * 4.7.1 provider sends its own awareness right after Auth and Step1, before its Step2 or any queued Update (with Docmost's
 * static token; pinned by the client's collab-provider-order.test.ts), so a sender that announced ids and writes another
 * never-seen one is relaying a peer's structs. Residual: a doc whose id Yjs regenerated (a remote write at its current
 * id) keeps announcing the old one, so its new id stays unbound (relay-binding.spec.ts); the guard refuses that remote
 * write at every bound id, so on an honest page it follows only an id collision.
 */
const ownedBy =
  (announced: Set<number> | undefined) =>
  (client: number): boolean =>
    announced === undefined || announced.has(client);

/** The UTF-8 bytes `null`: y-protocols' encoding of a removed state (`JSON.stringify(null)`). */
const isNullState = (state: Uint8Array): boolean =>
  state.length === 4 && state[0] === 0x6e && state[1] === 0x75 && state[2] === 0x6c && state[3] === 0x6c;

/** The frame header, decoded exactly as Hocuspocus's MessageReceiver does (one sync message per frame, V1). */
function readHeader(update: Uint8Array): Header | null {
  try {
    const d = decoding.createDecoder(update);
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type === MessageType.Sync || type === MessageType.SyncReply) {
      const subtype = decoding.readVarUint(d);
      if (subtype !== STEP2 && subtype !== UPDATE) return { type, subtype };
      return { type, subtype, payload: tryRead(() => decoding.readVarUint8Array(d)) };
    }
    if (type === MessageType.Awareness) return { type, payload: tryRead(() => decoding.readVarUint8Array(d)) };
    return { type };
  } catch {
    return null;
  }
}
const tryRead = (read: () => Uint8Array): Uint8Array | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/**
 * The stateless rules, on the decoded frame (no document state, so already-known structs are checked too), and the
 * client ids of its structs (Skips excepted: they integrate nothing). `Y.decodeUpdate` keeps the wire order of the
 * delete set (`readDeleteSet` appends, it never sorts).
 */
function prePass(payload: Uint8Array): { violation: Violation | null; clients: Set<number> } {
  const clients = new Set<number>();
  let decoded: { structs: Array<Y.Item | Y.GC | Y.Skip>; ds: { clients: Map<number, Array<{ clock: number; len: number }>> } };
  try {
    decoded = Y.decodeUpdate(payload) as typeof decoded;
  } catch {
    return { violation: { rule: 'undecodable' }, clients }; // e.g. a lib0 `readAny` value deep enough to overflow the decoder
  }
  let violation: Violation | null = null;
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) continue;
    clients.add(struct.id.client);
    if (struct instanceof Y.Item) violation ??= structRule(struct);
  }
  return { violation: violation ?? deleteOrder(decoded.ds.clients), clients };
}

function structRule(struct: Y.Item): Violation | null {
  const parent = struct.parent as unknown;
  if (typeof parent === 'string' && parent !== 'default') return { rule: 'root' };
  if (parent === 'default' && struct.parentSub !== null) return { rule: 'attr-kind' };
  if (struct.parentSub === '__proto__') return { rule: 'attr-kind' };
  const content = struct.content;
  if (content.getLength() === 0) return { rule: 'zero-length' };
  if (content instanceof Y.ContentString || content instanceof Y.ContentDeleted) return null;
  if (content instanceof Y.ContentAny) {
    for (const value of content.arr) {
      const rule = checkValue(value);
      if (rule) return { rule };
    }
    return null;
  }
  if (content instanceof Y.ContentFormat) return checkFormat(content.key, content.value);
  if (content instanceof Y.ContentType) {
    const type = content.type;
    if (type.constructor === Y.XmlText) return null;
    if (type.constructor === Y.XmlElement) {
      return isElementName((type as Y.XmlElement).nodeName) ? null : { rule: 'schema' }; // y-tiptap deletes it on every peer
    }
  }
  return { rule: 'content-kind' }; // Embed, Binary, JSON, Doc (a subdocument), or a non-Xml shared type
}

/**
 * #816: each client's delete ranges ascending and apart, in wire order (`start >= previous end`). Every Yjs encoder
 * writes them so (a transaction's `sortAndMergeDeleteSet`, `createDeleteSetFromStructStore`, `mergeDeleteSets` in
 * `mergeUpdates`; `diffUpdate` passes its input's order through). Out of order, each range that splits a struct inserts
 * near the front of the client's struct array: quadratic in the ranges.
 */
function deleteOrder(ds: Map<number, Array<{ clock: number; len: number }>>): Violation | null {
  for (const ranges of ds.values()) {
    let end = 0;
    for (let i = 0; i < ranges.length; i++) {
      if (i > 0 && ranges[i].clock < end) return { rule: 'delete-order' };
      end = ranges[i].clock + ranges[i].len;
    }
  }
  return null;
}

/**
 * Root, kind and value rules for one struct the frame added, and what it touches: the element whose children or
 * attributes changed, the element owning a changed XmlText, and every element the frame created.
 */
function checkStruct(item: Y.Item, root: Y.AbstractType<any> | undefined, touched: Set<Y.AbstractType<any>>, newTypes: Y.AbstractType<any>[]): Violation | null {
  const parent = item.parent as Y.AbstractType<any>;
  const parentKind = kindOf(parent);
  if (rootOf(parent) !== root) return { rule: 'root' };
  // #816: Yjs never writes a keyed item with a rightOrigin (typeMapSet and redo leave it null; a split copies it), and one
  // re-walks its key's history. Checked here, not in the pre-pass: an item with an origin or a rightOrigin takes its key
  // from them at integrate time (Yjs's readItem reads parentSub only when both are null), so the wire never shows it.
  if (item.parentSub !== null && item.rightOrigin !== null) return { rule: 'attr-kind' };
  if (item.deleted) return null; // ContentDeleted, or deleted on arrival: nothing of it is ever rendered or stored
  const content = item.content;
  if (item.parentSub !== null) {
    if (parentKind !== 'element' || !(content instanceof Y.ContentAny)) return { rule: content instanceof Y.ContentType ? 'content-kind' : 'attr-kind' };
    const v = checkAttribute((parent as Y.XmlElement).nodeName, item.parentSub, content.arr, { yjs: true });
    if (v) return v;
    touched.add(parent);
    return null;
  }
  if (parentKind === 'text') {
    if (content instanceof Y.ContentFormat) {
      const v = checkFormat(content.key, content.value);
      if (v) return v;
    } else if (!(content instanceof Y.ContentString)) {
      return { rule: 'text-kind' };
    }
    touched.add(parent._item!.parent as Y.AbstractType<any>);
    return null;
  }
  if (parent !== root && parentKind !== 'element') return { rule: 'child-kind' };
  if (!(content instanceof Y.ContentType)) return { rule: 'child-kind' };
  const type = content.type as Y.AbstractType<any>;
  const kind = kindOf(type);
  if (kind === 'element') touched.add(type);
  else if (kind !== 'text') return { rule: 'content-kind' };
  else if (parent === root) return { rule: 'child-kind' }; // any root XmlText stops the page opening (even if the root is legacy)
  newTypes.push(type);
  touched.add(parent);
  return null;
}

/** The table a touched table, row or cell belongs to (the structure its extent is computed from). */
function enclosingTable(type: Y.AbstractType<any>): Y.XmlElement | null {
  let t: Y.AbstractType<any> | null = type;
  for (let up = 0; up < 3 && t && kindOf(t) === 'element'; up++) {
    const name = (t as Y.XmlElement).nodeName;
    if (name === 'table') return t as Y.XmlElement;
    if (name !== 'tableRow' && name !== 'tableCell' && name !== 'tableHeader') return null;
    t = t._item ? (t._item.parent as Y.AbstractType<any>) : null;
  }
  return null;
}

/** A deleted struct touches the element whose children, attributes or text it changed. */
function touch(item: Y.Item, touched: Set<Y.AbstractType<any>>): void {
  const parent = item.parent as Y.AbstractType<any>;
  if (item.parentSub === null && kindOf(parent) === 'text') touched.add(parent._item!.parent as Y.AbstractType<any>);
  else touched.add(parent);
}

/** Exact Yjs type kinds (XmlHook extends Y.Map, XmlText extends Y.Text, XmlElement extends XmlFragment). */
function kindOf(type: unknown): 'element' | 'text' | 'other' {
  const ctor = (type as { constructor?: unknown } | null)?.constructor;
  return ctor === Y.XmlElement ? 'element' : ctor === Y.XmlText ? 'text' : 'other';
}

function rootOf(type: Y.AbstractType<any>): Y.AbstractType<any> {
  let t = type;
  while (t._item !== null) t = t._item.parent as Y.AbstractType<any>;
  return t;
}
function depthOf(type: Y.AbstractType<any>): number {
  let depth = 0;
  for (let t = type; t._item !== null && depth <= COLLAB_LIMITS.elementDepth; t = t._item.parent as Y.AbstractType<any>) depth++;
  return depth;
}
function isVisible(type: Y.AbstractType<any>): boolean {
  for (let t = type; t._item !== null; t = t._item.parent as Y.AbstractType<any>) if (t._item.deleted) return false;
  return true;
}
const idOf = (type: Y.AbstractType<any>): string => (type._item ? `${type._item.id.client}:${type._item.id.clock}` : 'root');
const pageIdOf = (live: { name?: string }): string | undefined => live.name?.replace(/^page\./, '');

/** Does store `a` hold every clock store `b` holds? */
function statesCover(a: Y.Doc['store'], b: Y.Doc['store']): boolean {
  for (const client of b.clients.keys()) if (Y.getState(a, client) < Y.getState(b, client)) return false;
  return true;
}

/** The ID ranges of a store's pending structs and pending deletes (both V2 updates). */
function pendingRanges(store: Y.Doc['store']): Ranges {
  const out: Ranges = new Map();
  const add = (client: number, start: number, end: number) => {
    if (!out.has(client)) out.set(client, []);
    out.get(client)!.push([start, end]);
  };
  if (store.pendingStructs) {
    for (const s of Y.decodeUpdateV2(store.pendingStructs.update).structs) add(s.id.client, s.id.clock, s.id.clock + s.length);
  }
  if (store.pendingDs) {
    for (const [client, items] of Y.decodeUpdateV2(store.pendingDs).ds.clients) for (const d of items) add(client, d.clock, d.clock + d.len);
  }
  return out;
}

/** Is every range of `inner` inside one range of `outer`? */
function covers(outer: Ranges, inner: Ranges): boolean {
  for (const [client, ranges] of inner) {
    const bounds = outer.get(client) ?? [];
    for (const [start, end] of ranges) if (end > start && !bounds.some(([s, e]) => s <= start && end <= e)) return false;
  }
  return true;
}
const inRanges = (ranges: Ranges, client: number, clock: number, length: number): boolean =>
  (ranges.get(client) ?? []).some(([s, e]) => s <= clock && clock + length <= e);
