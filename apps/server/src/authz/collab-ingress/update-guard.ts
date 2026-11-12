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
 * frames accepted but not yet applied (`inflight`), keeping it an exact image of live's future. Both the stateless
 * pre-pass and the shadow judge only what Yjs will integrate: a struct live already holds in full (a y-indexeddb
 * remount resends the whole local copy, the server's own `/v1` ledger entries and pre-#781 content included) is a
 * no-op in Yjs and is not refused for its content (see `heldByLive`). The shadow also reads where Yjs LINKED each new
 * item, not only the parent it names: an item linked after a neighbour of another list is refused `cross-list`.
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
 * shadow step is timed and charged, and (#840) so is live's own apply of it, and a frame that arrives while that
 * user's balance is negative closes the socket 1013 before any work. A rebuild a refusal made necessary is charged to
 * the refused user.
 *
 * Yjs bounds (#827, doc-bounds.ts). What the meter cannot count (formatting cleanup after a delete, struct splits,
 * load-order inversion) runs under a wall-clock deadline (deadline.ts), innermost inside the meter: a frame's shadow
 * apply (T_FRAME_MS; a timeout discards the shadow, and the first one for a (user, document) is a 1013 `frame_deadline`,
 * a repeat with nothing accepted in between the 4422 `apply-deadline`, so a GC pause passes and a deterministic frame
 * does not), every rebuild (a load, under the step budget W_MAX too), a server-local update mirrored into the shadow,
 * and the probe. A Step2/Update payload over PAGE_MAX_YDOC_BYTES is refused `frame-too-large` before it is decoded.
 * Per-page structure caps (structs, client ids, live children of one element, load walk steps) are counted on what each
 * frame touched: past a soft cap compaction is requested for the next unload; a frame that grows the page past a hard
 * cap closes 1013 `ccc:collab-page-compacting` and the page drains (every socket closed 1013) so it can compact, but
 * only when compaction (which keeps every live struct and child, measured at each rebuild, mirror and probe) would
 * bring the page and that frame under the soft caps; otherwise, or when it is over again within the compaction
 * interval, the frame is `page-full` (growth refused 4422, deletes pass) and nothing drains. The probe, a few seconds after
 * accepted growth, loads the shadow's encoding into a scratch document under the step budget (never swapped in), so an
 * inversion no cap can see is caught within one probe interval. A connection's FIRST frame is checked against the
 * page's lineage epoch (`?cccEpoch`, compaction-registry.ts): a copy of another lineage is refused 4422
 * `epoch-stale:<N>` before the server answers anything, readers and report mode included. Joins to, and frames for, a
 * document that is compacting, draining or superseded get the 1013 compacting close. QueryAwareness is refused
 * `message-type`: no 4.7.1 provider sends it, and 4.7.1 encodes every awareness state for it and discards the result.
 *
 * Exact shadow (#840). A reload of live is NOT live: Yjs integrates some frames into one order incrementally and another
 * after `applyUpdate(new Y.Doc(), encodeStateAsUpdate(live))` (order-parity.ts), so a shadow rebuilt by reload could
 * accept a frame that leaves live schema-invalid, and meter a frame cheap that walks millions of steps on live. So a
 * rebuild keeps a reload only when it strict-equals live (it then becomes the replay log's new checkpoint); otherwise it
 * replays live's own inputs (exact-replica-registry.ts: the checkpoint, each accepted frame's raw bytes and each
 * server-local update, in live's order) and the replay must strict-equal live (the tripwire) before the in-flight frames
 * go on top. A page that cannot be rebuilt exactly (no trusted log, the tripwire, the replay's bounds) closes its
 * writers' frames 1013 and drains to heal (compaction from live). Two rules a replay's exactness needs, both 4422 and
 * never written by an honest client: `parent-split` (a new item beside a neighbour of another parent or key) and
 * `keyed-split` (a live keyed item that is not one standalone value, #847). Live's own apply of each accepted frame is
 * timed and charged to its sender (the shadow's apply once, live's once); live far slower than the shadow marks the
 * shadow for a verified rebuild. A joiner's SyncStep1 (its Step2 answer, and every reload, is in reload order) is
 * answered only for a page whose shadow (live plus the frames in flight) is reload-stable, and with frames in flight
 * live too, checked once per change of what a joiner can get and charged to the joiner; an unstable page answers 1013
 * and heals. Senders whose items contradict their own origins (an origin not to the item's left, a rightOrigin not to
 * its right, or one of their own earlier items between) are suspects (with none, the senders whose walks reached no
 * verdict stand in: padding past the walk cap buys no way out); an instability found strikes them, once per
 * episode (until a stable verdict or a heal), and two strikes on a page within an hour hold that user's writer frames
 * there at 1013 for an hour. Never a refusal: blame is a heuristic. The replay logs are native memory: capped per page
 * and in total (exact-replica-registry.ts); a log dropped for either, or for frames live applied out of the guard's
 * order, makes the next frame or join rebuild and re-verify the page.
 *
 * Owner claims (#842, relay-claims.ts). New clocks at an id whose owner has only announced it (`awarenessOnly`) from
 * another user are a relay of the owner's lost structs or a forgery, and only content identity tells them apart. So
 * an owner's frame refused that way (`unproven-owner`) leaves a claim: its own structs and delete set, bounded per user
 * and per process, for CLAIM_TTL_MS. A peer's relay there is compared with the claim before the shadow step (R0–R6:
 * every struct, position and content, piece by piece); attested clocks bind nothing, prove nothing, and pass through
 * every rule below, and the apply must leave them as compared (deleted, or GC with evidence). A failed comparison
 * spends that relayer's one guess on that claim. So co-editors whose frames each carry another's unproven id (a crash
 * that lost both their tails) no longer block each other; a forgery is still never applied. Two pre-pass shape rules
 * keep the decoded frame equal to what Yjs integrates: no zero-length struct of any kind, one block per client
 * (`client-blocks`).
 *
 * Refusal = a throw of `{ code: 4422, reason }`: Hocuspocus closes that ONE document session and sends the reason (the
 * websocket stays up). Reasons the client acts on (apps/client features/editor-ux): `ccc:collab-update-refused:<rule>`
 * (stop sending, read-only, notice) and `ccc:collab-update-unresolved` (retry: a missing dependency, or new clocks at
 * an id whose owner has only announced it so far that no owner claim attests, logged `foreign-client` at stage
 * `unproven-owner` with the claim word). A
 * socket whose sessions are refused SOCKET_REFUSAL_BUDGET times is closed outright. An exhausted (user, document) budget is NOT a refusal: the
 * socket is closed 1013 (`tryLater`), which the editor retries. `COLLAB_UPDATE_GUARD=report` logs instead of either,
 * except for the rules no honest client ever trips and whose apply would outlive the kill switch (`ALWAYS_ENFORCED`).
 */
import { Logger } from '@nestjs/common';
import * as decoding from 'lib0/decoding';
import { decodeUtf8 } from 'lib0/string';
import * as Y from 'yjs';
import { isTransactionOrigin, MessageType } from '@hocuspocus/server';
import { PAGE_MAX_YDOC_BYTES } from '../page-write/page-size';
import { unloadCanCompact } from '../page-write/reconcile-store';
import {
  canStartCompaction,
  compactedRecently,
  compactionRequest,
  isClosedForCompaction,
  isDraining,
  pageFullUntil,
  lineageEpoch,
  markPageFull,
  requestCompaction,
  type CompactionReason,
} from '../page-write/compaction-registry';
import { COLLAB_CONNECTIONS_PER_USER } from './limits';
import { ClaimLedger, RelayClaims, verifyAttested, type Attested, type AttestResult, type ClaimOutcome, type DecodedFrame, type RecordOutcome } from './relay-claims';
import { ConflictScan, installConflictScanMeter, type ConflictScanMeter } from './conflict-scan';
import { COLLAB_PAGE_COMPACTING_REASON, epochStaleReason } from './collab-reasons';
import { COLLAB_PAGE_COMPACTION_TOKEN, logCompactionRequested, type CompactionLogSink } from './compaction-log';
import { isDeadlineExceeded, runWithDeadline, type DeadlineRunner } from './deadline';
import { capVerdict, compactionWouldHelp, liveStructure } from './live-structure';
import { EXACT_REPLICA_CAPS } from './exact-replica';
import {
  attachReplicaLog,
  distrustReplicaLog,
  encodingChanged,
  ensureReplicaLog,
  hasUnappliedFrames,
  LOG_OVER_CAP,
  LOG_OVER_TOTAL,
  mutationGeneration,
  noteAcceptedFrame,
  pendingStateOf,
  replicaLogDistrust,
  replicaLogNeedsReverify,
  replicaLogOf,
  settleAcceptedFrames,
} from './exact-replica-registry';
import { strictOrderDiff } from './order-parity';
import { parentConsistencyViolation } from './parent-consistency';
import { COLLAB_ORDER_DIVERGENCE_TOKEN, logOrderDivergence, type OrderDivergenceSink, type OrderDivergenceWhere } from '../page-write/order-divergence-log';
import {
  COMPACT_MAX_LIVE_STRUCTS,
  C_MAX,
  E_MAX,
  LOAD_DEADLINE_MS,
  MIRROR_DEADLINE_MS,
  PROBE_DEADLINE_MS,
  PROBE_DEBOUNCE_MS,
  PROBE_MIN_INTERVAL_MS,
  readerStep2ChargeMs,
  S_MAX,
  T_FRAME_MS,
  W_MAX,
} from './doc-bounds';
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
/**
 * Rules that refuse in report mode too: no honest client trips them, and an applied frame would outlive the kill switch.
 * - `root` (#827): a client write to a server-only root (the lineage epoch, the write ledger), which keep lineages apart
 *   (a forged epoch fails every later connection and compaction).
 * - `zero-length` and `client-blocks` (#842, the pre-pass shape rules): a zero-length GC makes the page unencodable
 *   (never stored or answered again), and a repeated block shows the rules structs Yjs never integrates.
 */
export const ALWAYS_ENFORCED: ReadonlySet<string> = new Set(['root', 'zero-length', 'client-blocks']);
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
 * last exit, refused or not, and charged in full: the pre-pass decode, a rebuild, the shadow apply and its inspection;
 * and (#840) live's own apply of an accepted frame, timed on live when it runs (it can cost more than the shadow's).
 * A rebuild another user's refusal made necessary is charged to that user. The balance does not refill while the
 * charged work runs, and a charge is never clamped, so a frame costing T leaves its sender about 20·T of wall clock in
 * debt. A frame that arrives while the balance is negative closes the
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
/**
 * #840 blame: each walk from a new item toward its origin or its rightOrigin stops after SUSPECT_WALK items, and a
 * frame's walks after SUSPECT_WALK_PER_FRAME in all; either way with no verdict (`unclear`: struck only when an
 * instability finds no suspect).
 */
const SUSPECT_WALK = 1024;
const SUSPECT_WALK_PER_FRAME = 16_384;
/** #840: suspects kept per document (the oldest dropped), and how long a suspicion lasts. */
const SUSPECTS_PER_PAGE = 64;
export const ORDER_SUSPECT_WINDOW_MS = 60 * 60_000;
/** #840: strikes on one page within ORDER_STRIKE_WINDOW_MS that hold a user's writer frames there at 1013, and for how long. */
export const ORDER_STRIKES_TO_HOLD = 2;
export const ORDER_STRIKE_WINDOW_MS = 60 * 60_000;
export const ORDER_HOLD_MS = 60 * 60_000;
/** #840: live's apply of an accepted frame past LIVE_COST_FACTOR x its shadow apply + LIVE_COST_SLACK_MS: the shadow is re-verified. */
const LIVE_COST_FACTOR = 4;
const LIVE_COST_SLACK_MS = 50;

export const reasonFor = (rule: CollabRule): string => (rule === 'unresolved' ? UNRESOLVED_REASON : REFUSED_REASON_PREFIX + rule);

/**
 * The client message types 4.7.1's `MessageReceiver.apply` handles and an honest provider may send on an established
 * session (Stateless is refused on its own rule above, Auth on an established session on `auth`). Anything else falls
 * to its `default:` branch: one unrate-limited console.error per frame, and the session stays up. #827: QueryAwareness
 * is left out (refused `message-type`): the 4.7.1 provider never sends it, and 4.7.1 answers one by encoding every
 * awareness state and discarding the result (no reply callback on a connection), a pure CPU sink.
 */
const HANDLED = new Set<number>([MessageType.Sync, MessageType.Awareness, MessageType.SyncReply, MessageType.CLOSE]);
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
/**
 * Hocuspocus's Document: a Y.Doc with its page name, the awareness it has applied (`meta`: clientID → clock), and (#827)
 * its socket connections, which a drain closes.
 */
export type GuardDocument = Y.Doc & {
  name?: string;
  awareness?: { meta: Map<number, { clock: number }> };
  getConnections?(): Array<{ webSocket?: { close(code?: number, reason?: string): void }; readOnly?: boolean; context?: { user?: { id?: unknown } } }>;
};
/** The subset of Hocuspocus's `beforeHandleMessagePayload` the guard reads. */
export interface GuardFrame {
  connection: GuardConnection;
  document: GuardDocument;
  update: Uint8Array;
  context?: { user?: { id?: string } };
  /** #827: the connection's request query; `cccEpoch` is the lineage epoch of the client's local copy (absent = 0). */
  requestParameters?: { get(name: string): string | null };
}
/** #827: the per-page structure caps (doc-bounds.ts); specs pass smaller ones. */
export interface DocCaps {
  structs: number;
  clientIds: number;
  children: number;
  steps: number;
  /** Live structs: a hard cap on growth, and past it no structure-cap compaction (COMPACT_MAX_LIVE_STRUCTS). */
  compactLive: number;
}
/** #827: the deadlines, in ms (doc-bounds.ts). */
export interface GuardDeadlines {
  frame: number;
  load: number;
  probe: number;
  mirror: number;
}
export type ScheduleTimer = (fn: () => void, ms: number) => { cancel(): void };
const timerSchedule: ScheduleTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};
export interface CollabGuardOptions {
  mode?: CollabGuardMode;
  logger?: GuardLogger;
  limitLog?: SocketLimitLog;
  now?: () => number;
  cpuNow?: () => number;
  /** #827: the deadline runner (deadline.ts); specs inject one that times out on cue. */
  runWithDeadline?: DeadlineRunner;
  /**
   * #827: whether an unload could compact `live` (reconcile-store's `unloadCanCompact`: its row bytes are covered, and a
   * build of them has not failed for good, which never stops an order heal: `reason`, #840). Specs replace it.
   */
  rowCovered?: (live: Y.Doc, reason?: CompactionReason) => boolean;
  /** #827: the largest Step2/Update payload; PAGE_MAX_YDOC_BYTES. */
  maxFrameBytes?: number;
  caps?: Partial<DocCaps>;
  deadlines?: Partial<GuardDeadlines>;
  /** #827: the probe's timer (unref'd setTimeout). */
  schedule?: ScheduleTimer;
  /** #842: the process's owner-claim bytes (relay-claims.ts); specs pass smaller bounds. */
  claimLedger?: ClaimLedger;
}
type Header = { type: number; subtype?: number; payload?: Uint8Array | null };
/** One awareness entry, its state still the undecoded UTF-8 JSON. */
type AwarenessEntry = { clientID: number; clock: number; state: Uint8Array };
/**
 * #816: what a refusal line may add: numbers and fixed words only, never a value from the frame. `unproven-owner`: a
 * `foreign-client` at an id whose owner has only announced it, answered `unresolved` (inspectTransaction). #842 `claim`,
 * with it: why no owner claim attested the relay (`none`, `uncovered`: R1/R2, `mismatch`: a failed comparison, now
 * burned, `burned`: compared and failed before), or `full`: the sender's own claim found no room (relay-claims.ts).
 */
type RefusalLog = { steps?: number; stage?: 'conflict-scan' | 'unproven-owner'; claim?: ClaimOutcome | 'full' };
type ShadowResult = {
  violation: Violation | null;
  binds: Map<number, string>;
  /** Awareness-bound ids the sender wrote new clocks at as their owner (no longer `awarenessOnly` once accepted). */
  proven?: Set<number>;
  applied: boolean;
  log?: RefusalLog;
  /** #827: the shadow apply ran out of time (the shadow is discarded; live never applies the frame). */
  timedOut?: boolean;
  /** Legacy pending structs a frame released that the rules would refuse: logged after the apply, never refused. */
  reportOnly: Violation[];
  /** #827: structs integrated at new clocks (growth), the most live children of an element the frame added a child to,
   *  the change in the store's struct count, and its client ids before and after. */
  added: number;
  children: number;
  structDelta: number;
  clientsBefore: number;
  clientsAfter: number;
  /** #840: the frame's integrate walk on the shadow (the replay log's step cost), and whether its sender is a suspect;
   *  `unclear`: a walk that reached no verdict (its cap or the frame's budget), which counts only when nobody is a suspect. */
  steps: number;
  suspect: boolean;
  unclear: boolean;
  /** #840: the shadow's encoding may have changed (`encodingChanged`): what the join check's cache key counts. */
  changes: boolean;
  /** #842: attested ids the frame wrote new clocks at (accepted: COLLAB_RELAY_ATTESTED), and those whose apply failed
   *  their R4/R6 checks (`verifyAttested`: refused `unproven-owner`, the relayer burned when `failed`). */
  relayed?: Set<number>;
  relayFailed?: Map<number, 'pending' | 'failed'>;
};
/** What `inspectTransaction` finds inside the transaction. `extra`: struct-array lengths, mid-transaction, of clients a
 *  delete reached that the pre-pass did not name (a keyed overwrite deletes the key's previous item). */
type Inspection = {
  violation: Violation | null;
  log?: RefusalLog;
  binds: Map<number, string>;
  proven: Set<number>;
  reportOnly: Violation[];
  added: number;
  children: number;
  extra: Map<number, number>;
  /** #840: an item contradicts its own origins (blame, never a refusal); or no walk could tell (`unclear`). */
  suspect: boolean;
  unclear: boolean;
  /** #842: see ShadowResult. */
  relayed: Set<number>;
  relayFailed: Map<number, 'pending' | 'failed'>;
};
type Ranges = Map<number, Array<[number, number]>>;
type PrePass = {
  violation: Violation | null;
  /** The client ids of its structs (Skips excepted). */
  clients: Set<number>;
  /** #827: other client ids whose struct arrays the apply can split or merge: dependencies (origin, rightOrigin, parent)
   *  and delete-set clients. */
  reaches: Set<number>;
  /** #827: per client, the clock its structs end at: what live must hold once it applied the frame. */
  ends: Map<number, number>;
  /** #842: the decoded frame (the relay comparison reads it; null when undecodable), and every client it has structs
   *  at, held ones included (an owner claim keeps only the claimed ids' structs). */
  decoded: DecodedFrame | null;
  structClients: Set<number>;
};
/** #840 `diverged`: no exact shadow can be built (no trusted log, the tripwire, the replay's bounds) until the page heals. */
type ShadowState = 'ready' | 'unavailable' | 'compacting' | 'diverged';

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
  /** #816: the user whose refused frame left the shadow dirty: the rebuild is charged to them, not the next sender.
   *  SERVER (#827): a server-caused rebuild (a mirror failure), charged to no one. */
  dirtiedBy: string | null = null;
  /** #827: structs in the shadow's store (exact after a rebuild, a mirror and a probe; moved by each frame's delta). */
  structs = 0;
  /** #827: walk steps of the last full load of the page (a rebuild or a probe). */
  steps = 0;
  /** #827: what a compaction would keep, measured exactly (`liveStructure`) at the last rebuild, mirror or probe: the
   *  live (non-deleted) structs and the most live children of one element; and `structs` at that moment, so the growth
   *  since is added on top (`compactionHelps`). Accepted frames raise `liveChildren` by what they touched. */
  liveStructs = 0;
  liveChildren = 0;
  structsAtMeasure = 0;
  /** #827: the page cannot be replicated within the load bounds: every writer frame closes 1013 until it compacts. */
  overBounds = false;
  /** #827: per in-flight frame, client → the clock live must reach once it applied it (replaces an O(ids) state cover). */
  readonly targets: Array<Map<number, number>> = [];
  /** #827: frames accepted and applied to the shadow since the last flush: live's connection-origin updates are their
   *  echoes. One with none outstanding was never inspected, so the shadow is stale. */
  pendingEchoes = 0;
  /** #827: the probe: who grew the page since the last one (charged for it), its timer, when it last ran. */
  readonly writersSinceProbe = new Set<string>();
  probeTimer: { cancel(): void } | null = null;
  probeQueued = false;
  lastProbeAt = Number.NEGATIVE_INFINITY;
  destroyed = false;
  /** #840: no exact shadow can be built: writers wait (1013) and the page heals. Final for this document. */
  diverged = false;
  /** #840: frames accepted on this document that can change its encoding (with live's generation, the join check's cache
   *  key) and the last key verified. */
  accepted = 0;
  verified: string | null = null;
  /** #840: the last key a join found unstable: until it changes, a joiner waits (1013) without another reload. */
  unstableAt: string | null = null;
  /** #840: user → when they last sent an item contradicting its own origins (oldest first, SUSPECTS_PER_PAGE at most). */
  readonly suspects = new Map<string, number>();
  /** #840: likewise, the users whose walks reached no verdict (padding past SUSPECT_WALK, a spent frame budget): struck
   *  only by an instability with no suspect, so a frame cannot buy its way out of blame with a long walk. */
  readonly unclear = new Map<string, number>();
  /**
   * #840: the instability episode: from the first unstable verdict until a stable one or a heal (a new document, or a
   * new lineage epoch on this one). Each user is struck at most once per episode (`struck`, bounded by
   * SUSPECTS_PER_PAGE per verdict), however many joins or probes find the page unstable while it cannot heal yet.
   */
  episode: { epoch: number | null; struck: Set<string> } | null = null;
  constructor(
    readonly live: GuardDocument,
    /** #842: owner claims (relay-claims.ts): what an owner sent in a frame refused `unproven-owner`. */
    readonly claims: RelayClaims,
  ) {}
}

type Bucket = { tokens: number; at: number };
/** `cpu` (milliseconds, #816) is only used on the whole-user entry. `deadline` (#827): shadow-apply timeouts since this
 *  (user, document)'s last accepted frame (the strike rule). `strikes`/`heldUntil` (#840): when instabilities this user
 *  was a suspect of were found on the page, and until when their writer frames there wait (1013). Kept by page name, so
 *  a heal (a new document) does not forgive them. */
type UserDocBudget = { sync: Bucket; ids: Bucket; cpu: Bucket; deadline: number; strikes: number[]; heldUntil: number };

export class CollabUpdateGuard {
  private readonly docs = new WeakMap<Y.Doc, DocGuard>();
  private readonly refusedConnections = new WeakMap<object, string>();
  private readonly socketRefusals = new WeakMap<object, number>();
  /** #790: per (user, document) budgets, least recently used first; and per connection, the ids it already paid for. */
  private readonly userDocBudgets = new Map<string, UserDocBudget>();
  private readonly awarenessNewIds = new WeakMap<object, Set<number>>();
  /** Read by the guard extension too: the load repair runs only in enforce mode (#841). */
  readonly mode: CollabGuardMode;
  private readonly logger: GuardLogger;
  private readonly limitLog: SocketLimitLog;
  private readonly now: () => number;
  /** Guard lines, LOGS_PER_MINUTE per token a minute; the rest are counted (socket-limit-log.ts, #810). */
  private readonly logLines = new RateLimitedWarn<string>({
    logger: { warn: (message) => this.logger.warn(message) },
    perKey: LOGS_PER_MINUTE,
    summary: (token, count) => `COLLAB_GUARD_LOG_SUPPRESSED ${JSON.stringify({ of: token, count })}`,
  });
  /** #827: compaction-log.ts's lines, through the same per-token window. */
  private readonly compactionLog: CompactionLogSink = {
    warn: (line) => this.logLines.warn(COLLAB_PAGE_COMPACTION_TOKEN, () => line),
  };
  /** #840: order-divergence lines, through the same per-token window. */
  private readonly divergenceLog: OrderDivergenceSink = {
    warn: (line) => this.logLines.warn(COLLAB_ORDER_DIVERGENCE_TOKEN, () => line),
  };
  private readonly cpuNow: () => number;
  private readonly meter: ConflictScanMeter;
  /** #827: named so deadline.fitness.spec.ts finds every call. */
  private readonly runWithDeadline: DeadlineRunner;
  private readonly rowCovered: (live: Y.Doc, reason?: CompactionReason) => boolean;
  private readonly maxFrameBytes: number;
  private readonly caps: DocCaps;
  private readonly deadlines: GuardDeadlines;
  private readonly schedule: ScheduleTimer;
  /** #827: connections whose first frame passed the epoch rule. */
  private readonly epochChecked = new WeakSet<object>();
  /** #827: probes due, run one per macrotask (each is synchronous work of up to PROBE_DEADLINE_MS). */
  private readonly probeQueue: DocGuard[] = [];
  private probeDraining = false;
  /** #842: the owner-claim bytes of every document in this process (relay-claims.ts). */
  private readonly claimLedger: ClaimLedger;

  constructor(opts: CollabGuardOptions = {}) {
    this.mode = opts.mode ?? COLLAB_UPDATE_GUARD_MODE;
    this.logger = opts.logger ?? new Logger('CollabUpdateGuard');
    this.limitLog = opts.limitLog ?? collabSocketLimitLog;
    this.now = opts.now ?? Date.now;
    this.cpuNow = opts.cpuNow ?? (() => performance.now());
    this.runWithDeadline = opts.runWithDeadline ?? runWithDeadline;
    this.rowCovered = opts.rowCovered ?? ((live, reason) => unloadCanCompact(live, pageIdOf(live as { name?: string }) ?? '', reason));
    this.maxFrameBytes = opts.maxFrameBytes ?? PAGE_MAX_YDOC_BYTES;
    this.caps = { structs: S_MAX, clientIds: C_MAX, children: E_MAX, steps: W_MAX, compactLive: COMPACT_MAX_LIVE_STRUCTS, ...opts.caps };
    this.deadlines = { frame: T_FRAME_MS, load: LOAD_DEADLINE_MS, probe: PROBE_DEADLINE_MS, mirror: MIRROR_DEADLINE_MS, ...opts.deadlines };
    this.schedule = opts.schedule ?? timerSchedule;
    this.claimLedger = opts.claimLedger ?? new ClaimLedger();
    // Throws when yjs changed shape, so the server refuses to boot rather than run unbounded (#816).
    this.meter = installConflictScanMeter(Y);
  }

  /** Synchronous: returns undefined (apply the frame) or throws `{ code, reason }` (refuse it). Never a promise. */
  check(frame: GuardFrame): void {
    const earlier = this.refusedConnections.get(frame.connection);
    if (earlier) throw { code: COLLAB_REFUSAL_CODE, reason: earlier };
    const header = readHeader(frame.update);
    if (!header) return; // not decodable as a frame: Hocuspocus refuses it itself
    // #827: the page's lineage gates, in every mode (they keep lineages apart; they are not content rules). A provider's
    // detach still closes its session as asked.
    if (header.type !== MessageType.CLOSE && isClosedForCompaction(frame.document)) return this.compacting(frame, true);
    if (!this.epochChecked.has(frame.connection)) this.checkEpoch(frame, header);
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
    // #827: before anything decodes it, readers too (a reader's Step2 is snapshot-checked). The ws cap stays 8 MiB.
    if ((header.subtype === STEP2 || header.subtype === UPDATE) && header.payload && header.payload.length > this.maxFrameBytes) {
      return this.refuse(frame, header, { rule: 'frame-too-large' });
    }
    // A Step1 makes Hocuspocus encode the whole document (its Step2 answer); a reader's Step2 makes it snapshot it.
    if (header.subtype === STEP1 || (header.subtype === STEP2 && frame.connection.readOnly)) {
      const ok = this.takeBoth(
        [this.budgetFor(frame, true).sync, USER_SYNC_BURST, USER_SYNC_REFILL_MS],
        [this.budgetFor(frame).sync, SYNC_BURST, SYNC_REFILL_MS],
      );
      if (!ok) this.tryLater(frame, 'user_sync_budget');
      if (header.subtype === STEP2) this.chargeReaderStep2(frame, header.payload?.length ?? 0);
      else this.checkJoin(frame); // #840: its Step2 answer is what a reload builds
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

  /** #840: the users suspected on `live` now (specs and diagnostics). */
  suspectsOf(live: Y.Doc): string[] {
    return [...(this.docs.get(live)?.suspects.keys() ?? [])];
  }

  /** #827: the structure counts the guard holds for `live` (specs and diagnostics). */
  pageCounts(live: Y.Doc): { structs: number; clientIds: number; steps: number } | null {
    const doc = this.docs.get(live);
    return doc ? { structs: doc.structs, clientIds: doc.shadow?.store.clients.size ?? 0, steps: doc.steps } : null;
  }

  /** #827: run `live`'s probe now (specs and diagnostics); false when there is nothing to probe. */
  probeNow(live: Y.Doc): boolean {
    const doc = this.docs.get(live);
    if (!doc) return false;
    doc.probeTimer?.cancel();
    doc.probeTimer = null;
    return this.probe(doc);
  }

  /** #827: the clocks the load hooks charge with (collab-update-guard.extension.ts). */
  cpuClock(): number {
    return this.cpuNow();
  }
  wallClock(): number {
    return this.now();
  }

  /**
   * #827: may a socket's load of a page start for `user`? Not while that user is in collab CPU debt (a load is charged
   * to the socket that caused it, so a reload loop pays for itself): logged `load_debt`. Report mode only logs.
   */
  admitLoad(user: string): boolean {
    if (this.cpuBalance(user) >= 0) return true;
    this.limitLog.log('load_debt', { userId: user });
    return this.mode === 'report';
  }

  /** #827: charge a socket's load (its load transactions' time) to `user`, as a frame's work is charged. */
  chargeLoad(user: string, ms: number, workStarted: number): void {
    this.chargeCpu(user, ms, workStarted);
  }

  /**
   * #827: may a connection join the resident `document` (undefined: not resident)? Not while it is compacting, draining
   * or superseded: its sockets are being closed so it can unload, and a superseded one must never serve. Every mode.
   * Asked only once the connection is AUTHENTICATED (the extension's `connected`): a client that has not passed auth
   * never learns a page is compacting.
   */
  admitJoin(document: object | undefined, user: string): boolean {
    if (document === undefined || !isClosedForCompaction(document)) return true;
    this.limitLog.log('page_compacting', { userId: user });
    return false;
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
        deadline: 0,
        strikes: [],
        heldUntil: 0,
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
   * #827: the page is compacting, draining or must compact first: close this frame's SOCKET 1013 with the compacting
   * reason (non-detaching: the editor waits read-only and retries), then throw. `always`: the lineage gates, which hold
   * in report mode too; otherwise report mode only logs.
   */
  private compacting(frame: GuardFrame, always = false): void {
    this.limitLog.log('page_compacting', { userId: String(frame.context?.user?.id ?? '') });
    if (this.mode === 'report' && !always) return;
    try {
      frame.connection.webSocket?.close(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
    } catch {
      // already closing
    }
    throw { code: COLLAB_TRY_LATER_CODE, reason: COLLAB_PAGE_COMPACTING_REASON };
  }

  /**
   * #827: a connection's first frame names the lineage of its client's copy (`?cccEpoch`, absent = 0). Another lineage
   * is refused 4422 `epoch-stale:<page's epoch>` before the server answers anything (a Step1's answer would merge the
   * page into the old copy, and the copy's Step2 would merge back): readers too, in report mode too, and not counted
   * toward the socket's refusal budget (an honest stale tab is not misbehaving). Later frames of the connection get the
   * same answer.
   */
  private checkEpoch(frame: GuardFrame, header: Header): void {
    this.epochChecked.add(frame.connection);
    let epoch: number;
    try {
      epoch = lineageEpoch(frame.document);
    } catch {
      // A malformed lineage root: fail closed in every mode, never guess (an epoch gate, not a content rule)
      this.refuse(frame, header, { rule: 'internal' }); // enforce: throws
      const reason = reasonFor('internal');
      this.refusedConnections.set(frame.connection, reason); // report mode: this connection's later frames too
      throw { code: COLLAB_REFUSAL_CODE, reason };
    }
    if (clientEpoch(frame.requestParameters) === epoch) return;
    const reason = epochStaleReason(epoch);
    this.log('COLLAB_UPDATE_REFUSED', frame.document, {
      rule: 'epoch-stale',
      epoch,
      userId: frame.context?.user?.id,
      msgType: header.type,
      readOnly: frame.connection.readOnly,
      mode: this.mode,
    });
    this.refusedConnections.set(frame.connection, reason);
    throw { code: COLLAB_REFUSAL_CODE, reason };
  }

  /**
   * #827: a reader's Step2 makes 4.7.1 decode it and snapshot the whole page. Charged to the reader's CPU debt (its
   * bytes, and the page's structs), never refused on size below the frame cap; a reader in debt waits (1013).
   */
  private chargeReaderStep2(frame: GuardFrame, bytes: number): void {
    const userId = String(frame.context?.user?.id ?? '');
    if (!this.take(this.budgetFor(frame, true).cpu, USER_COLLAB_CPU_BURST_MS, CPU_MS_REFILL_EVERY_MS, 0)) {
      this.tryLater(frame, 'user_collab_cpu'); // throws unless report mode
    }
    const known = this.docs.get(frame.document);
    const structs = known?.shadow ? known.structs : structCount(frame.document.store);
    this.chargeCpu(userId, readerStep2ChargeMs(bytes, structs), this.now());
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
    // 0. #816: a user in CPU debt waits, before any work; #840: so does one held for order strikes on this page.
    if (!this.take(this.budgetFor(frame, true).cpu, USER_COLLAB_CPU_BURST_MS, CPU_MS_REFILL_EVERY_MS, 0)) {
      this.tryLater(frame, 'user_collab_cpu'); // throws unless report mode
    }
    if (this.budgetFor(frame).heldUntil > this.now()) this.tryLater(frame, 'order_strikes'); // throws unless report mode
    // From here every exit is charged (#816): the pre-pass, any rebuild and the shadow apply, once; live's own apply when
    // it runs (#840). A rebuild someone else's refusal made necessary is theirs; one the server caused is no one's (#827).
    const workStarted = this.now();
    const started = this.cpuNow();
    let othersMs = 0;
    try {
      // 1. Pre-pass (the per-struct rules; it reads live's state, never the shadow): a refusal here touches no shadow,
      //    so a refuse/reconnect loop costs no rebuild.
      const pre = prePass(payload, frame.document);
      let violation = pre.violation;
      if (violation && this.enforces(violation.rule)) return this.refuse(frame, header, violation);
      // 1b. #816: client ids live has never seen, charged before anything integrates them.
      violation ??= this.chargeNewClientIds(frame, pre.clients);
      if (violation && this.enforces(violation.rule)) return this.refuse(frame, header, violation);
      // 1c. #842: new clocks at another user's awareness-only id, compared with that owner's claim (relay-claims.ts),
      //     against live's state (the shadow's new clocks never start below it). The shadow step then lets exactly the
      //     attested clocks through to every content rule, and checks the deletes and GCs they promised.
      const relay = this.attestRelays(doc, frame, userId, pre);
      // 2. The shadow step. #840: the replay log only grows between checkpoints and recording never drops an entry, so
      // an entry past its caps, or past the process total, makes it stop being trusted (exact-replica-registry.ts)
      // whoever wrote it (a server write is logged too). This frame then rebuilds first (charged to this user): a reload
      // equal to live re-arms it, otherwise the page heals. So a log never holds more than its cap, and all of them
      // never more than the total, whatever the page's caps see (an insert, deleted).
      this.reverify(doc, userId);
      const shadowed = this.readyShadow(doc, userId);
      othersMs = shadowed.othersMs;
      const ready = shadowed.ready;
      // #827: a page past the load bounds is replicated by no one until it compacts; its writers wait (1013).
      if (ready === 'compacting') return this.compacting(frame);
      // #840: nor is a page no exact shadow can be built for, until it heals.
      if (ready === 'diverged') return this.tryLater(frame, 'order_divergence');
      if (ready !== 'ready') return this.refuse(frame, header, violation ?? { rule: 'shadow-unavailable' });
      const applyStarted = this.cpuNow();
      const result = this.applyToShadow(doc, payload, userId, pre, ownedBy(doc.announced.get(frame.connection)), relay.attested);
      const applyMs = this.cpuNow() - applyStarted;
      if (result.timedOut) return this.deadlineStrike(frame, header);
      // A write outside `default` wins over a report-only pre-pass violation: it is refused in every mode
      violation = result.violation?.rule === 'root' ? result.violation : (violation ?? result.violation);
      if (!violation) for (const v of result.reportOnly) this.log('COLLAB_LEGACY_PENDING_INVALID', doc.live, { rule: v.rule });
      if (violation && this.enforces(violation.rule)) {
        // The shadow holds the refused frame; live never will. Rebuilt lazily by the next frame that needs it
        // (ensureShadow), so a refuse/reconnect loop pays no rebuild per refusal, and that rebuild is this user's.
        doc.dirty = true;
        doc.dirtiedBy = userId;
        return this.refuse(frame, header, violation, this.unprovenOwner(doc, frame, userId, payload, pre, relay, result));
      }
      if (violation) this.refuse(frame, header, violation, result.log); // report mode: logged, and the frame applies
      // 3. #827: the per-page structure caps, on what the frame changed.
      const caps = result.applied ? this.checkCaps(doc, result, userId) : 'ok';
      if (caps !== 'ok' && this.mode === 'enforce') {
        doc.dirty = true; // the shadow holds the refused frame, as above
        doc.dirtiedBy = userId;
      }
      if (caps === 'full') this.refuse(frame, header, { rule: 'page-full' }); // throws unless report mode
      if (caps === 'compact') this.compacting(frame); // throws unless report mode
      this.budgetFor(frame).deadline = 0; // an accepted frame clears the strike
      for (const [client, user] of result.binds) if (!doc.bindings.has(client)) doc.bindings.set(client, user);
      for (const client of result.proven ?? []) doc.awarenessOnly.delete(client);
      if (result.proven?.size) doc.claims.drop(userId); // #842: its ids are proven, its claim is moot
      if (result.relayed?.size) {
        // #842: a relay an owner claim attested (counts only)
        let clocks = 0;
        for (const client of result.relayed) clocks += relay.attested.get(client)!.to - relay.attested.get(client)!.from;
        this.log('COLLAB_RELAY_ATTESTED', doc.live, { userId, ids: result.relayed.size, clocks });
      }
      const raw = payload.slice();
      // A frame the shadow could not apply is not replayed into a rebuild (it would fail every rebuild from then on).
      if (result.applied) {
        doc.inflight.push(raw);
        doc.targets.push(pre.ends);
        doc.pendingEchoes++;
        if (result.added > 0) this.scheduleProbe(doc, userId);
      }
      if (result.suspect) this.suspect(doc, doc.suspects, userId);
      else if (result.unclear) this.suspect(doc, doc.unclear, userId);
      // #840: the join check's cache key counts only frames that can change what a joiner gets (an empty Step2 cannot)
      if (result.changes) doc.accepted++;
      // #840: live applies it next on this connection: its raw bytes go into the replay log then, and its apply is timed
      // and charged to this user. Last: nothing after it may throw.
      noteAcceptedFrame(doc.live, frame.connection, {
        raw,
        steps: result.steps,
        clock: this.cpuNow,
        wall: this.now,
        onApplied: (ms, wallStarted) => this.liveApplied(doc, userId, ms, applyMs, wallStarted),
      });
      this.scheduleFlush(doc);
    } finally {
      this.chargeCpu(userId, this.cpuNow() - started - othersMs, workStarted);
    }
  }

  /**
   * #842: the frame's new clocks at ids that are awareness-only and bound to another user, compared with each owner's
   * claim (relay-claims.ts). Enforce mode only (report mode records no claims). An owner's claim is used while its owner
   * has no read-only connection on the document (narrowed: dropped from use). Not "while the owner has a writer
   * connection": Hocuspocus removes a refused session's connection, so an owner whose frame was just refused has none
   * until its retry reconnects, which is exactly when its peers' relays must be judged; CLAIM_TTL_MS bounds an owner
   * that never returns.
   */
  private attestRelays(doc: DocGuard, frame: GuardFrame, userId: string, pre: PrePass): AttestResult {
    const candidates: number[] = [];
    for (const client of pre.clients) {
      const owner = doc.bindings.get(client);
      if (owner !== undefined && owner !== userId && doc.awarenessOnly.has(client)) candidates.push(client);
    }
    if (!candidates.length || this.mode !== 'enforce' || pre.decoded === null) return { attested: new Map(), failed: new Map() };
    const live = frame.document;
    return doc.claims.attest({
      relayer: userId,
      frame: pre.decoded,
      candidates,
      stateOf: (client) => Y.getState(live.store, client),
      ownerOf: (client) => doc.bindings.get(client),
      isAwarenessOnly: (client) => doc.awarenessOnly.has(client),
      ownerMayWrite: (owner) => !(live.getConnections?.() ?? []).some((c) => c.readOnly === true && String(c.context?.user?.id ?? '') === owner),
      now: this.now(),
    });
  }

  /**
   * #842: a frame refused for new clocks at an unproven owner's id (stage `unproven-owner`; any other refusal's log is
   * passed through). A relay that failed its post-apply checks burns its relayer for that claim. The sender's OWN
   * claim is recorded (enforce mode): its new clocks at ids bound to it, still awareness-only, and announced by this
   * connection. The log line says why no claim attested the relay (fixed words only).
   */
  private unprovenOwner(doc: DocGuard, frame: GuardFrame, userId: string, payload: Uint8Array, pre: PrePass, relay: AttestResult, result: ShadowResult): RefusalLog | undefined {
    if (result.log?.stage !== 'unproven-owner') return result.log;
    const outcomes = new Set<ClaimOutcome>(relay.failed.values());
    for (const [client, why] of result.relayFailed ?? []) {
      if (why === 'failed') doc.claims.burn(relay.attested.get(client)!.owner, userId);
      outcomes.add(why === 'failed' ? 'mismatch' : 'uncovered');
    }
    let recorded: RecordOutcome = 'none';
    if (this.mode === 'enforce') {
      const announced = doc.announced.get(frame.connection);
      const ids = new Set<number>();
      for (const client of pre.clients) {
        if (doc.bindings.get(client) === userId && doc.awarenessOnly.has(client) && announced?.has(client)) ids.add(client);
      }
      recorded = doc.claims.record(userId, ids, payload, pre.structClients, this.now());
    }
    const claim: ClaimOutcome | 'full' = outcomes.has('mismatch')
      ? 'mismatch'
      : outcomes.has('burned')
        ? 'burned'
        : recorded === 'full'
          ? 'full'
          : outcomes.has('uncovered')
            ? 'uncovered'
            : 'none';
    return { ...result.log, claim };
  }

  /**
   * #840: a log distrusted for its caps or the process total (`replicaLogNeedsReverify`) is re-armed only by a verified
   * checkpoint, so the page's shadow is rebuilt first (charged to `userId`): a reload equal to live re-arms it, otherwise
   * the page heals.
   */
  private reverify(doc: DocGuard, userId: string): void {
    if (doc.dirty || doc.shadow === null || !replicaLogNeedsReverify(doc.live)) return;
    doc.dirty = true;
    doc.dirtiedBy = userId;
  }

  /**
   * The shadow, rebuilt first if it is dirty (`ensureShadow`). A rebuild someone else's refusal made necessary is charged
   * to them (shadow-only work: once), one the server caused to no one; `othersMs` is what the caller must not charge.
   */
  private readyShadow(doc: DocGuard, userId: string): { ready: ShadowState; othersMs: number } {
    const dirtier = doc.dirty ? doc.dirtiedBy : null;
    const blame = dirtier !== null && dirtier !== userId ? dirtier : null;
    const rebuildStarted = blame === null ? 0 : this.cpuNow();
    const rebuildWallStarted = blame === null ? 0 : this.now();
    const ready = this.ensureShadow(doc);
    if (blame === null) return { ready, othersMs: 0 };
    const othersMs = this.cpuNow() - rebuildStarted;
    if (blame !== SERVER) this.chargeCpu(blame, othersMs, rebuildWallStarted);
    return { ready, othersMs };
  }

  /**
   * #840 part 4: live applied an accepted frame of `user` in `ms` (its own transaction, timed on live). Charged to them;
   * far over the shadow's `shadowMs` for the same frame, the shadow cannot have been live's exact image: it is rebuilt
   * (and verified) by the next frame. Runs inside a Yjs listener: never throws.
   */
  private liveApplied(doc: DocGuard, user: string, ms: number, shadowMs: number, wallStarted: number): void {
    try {
      this.chargeCpu(user, ms, wallStarted);
      if (ms <= LIVE_COST_FACTOR * shadowMs + LIVE_COST_SLACK_MS || doc.destroyed) return;
      this.divergence(doc, 'rebuild', 'live_cost', ms, [user]);
      doc.dirty = true;
      doc.dirtiedBy = user;
    } catch {
      // never out of a Yjs listener
    }
  }

  /** #840: `user` sent an item contradicting its own origins on this document, or (`doc.unclear`) one whose walk reached
   *  no verdict (most recent last; bounded). */
  private suspect(doc: DocGuard, into: Map<string, number>, user: string): void {
    into.delete(user);
    into.set(user, this.now());
    if (into.size > SUSPECTS_PER_PAGE) into.delete(into.keys().next().value!);
  }

  /**
   * #827: a frame whose shadow apply ran out of time. The first for this (user, document) since its last accepted frame
   * closes the socket 1013 (`frame_deadline`: a GC pause or a busy host passes on the retry); a repeat is refused 4422
   * `apply-deadline` (a provider resends the same Step2 on reconnect, so a deterministic frame lands here).
   */
  private deadlineStrike(frame: GuardFrame, header: Header): void {
    const budget = this.budgetFor(frame);
    if (budget.deadline > 0) return this.refuse(frame, header, { rule: 'apply-deadline' });
    budget.deadline = 1;
    this.tryLater(frame, 'frame_deadline');
  }

  /**
   * #827: the structure caps after an accepted shadow apply, counted on what the frame touched, through the one cap rule
   * (`capVerdict`, live-structure.ts). A frame that GROWS the page past a hard cap is refused. `compact` (1013, the page
   * drains and compacts) only when the page compacted, with this frame's growth on top (room for what its editor was
   * doing; the frame itself never applies, and the drain sends that editor's dirty copy to the Discard-first notice),
   * would sit under the soft caps (`compactionHelps`): its history is what is too big. Otherwise `full` (4422
   * page-full, nothing drains): its visible content is, and compaction keeps every live struct and child (so a children
   * cap is never compacted away; an honest dense paste never drains the page for nothing), or the page was compacted
   * within the interval and is over again. Under the hard caps, the
   * frame's counts are kept, and past a soft cap compaction is requested for the next unload, again only when it would
   * help. Deletes always pass.
   */
  private checkCaps(doc: DocGuard, result: ShadowResult, userId: string): 'ok' | 'full' | 'compact' {
    const structs = doc.structs + result.structDelta;
    const clients = result.clientsAfter;
    // The page's counts are still those without the frame; its growth (every struct it added, taken as live) and the
    // live children of what it touched are added on top.
    // Live structs: what a compaction keeps and must rebuild within COMPACTION_DEADLINE_MS, so past COMPACT_MAX_LIVE_STRUCTS
    // growth is page-full. The O(1) estimate takes every struct added since the last exact measure as live; past the cap
    // it is replaced by an exact count of the shadow (which holds this frame), so churn never refuses a page under it.
    const estimate = doc.liveStructs + Math.max(0, doc.structs - doc.structsAtMeasure) + result.added;
    const exactLive = result.added > 0 && estimate > this.caps.compactLive && doc.shadow ? liveStructure(doc.shadow).structs : undefined;
    const growth = capVerdict(
      [
        { reason: 'structs', n: structs, cap: this.caps.structs, grew: result.added > 0 },
        { reason: 'client_ids', n: clients, cap: this.caps.clientIds, grew: clients > result.clientsBefore },
        { reason: 'children', n: result.children, cap: this.caps.children },
        { reason: 'structs', n: exactLive ?? estimate, cap: this.caps.compactLive, grew: result.added > 0, hardOnly: true },
      ],
      () => this.compactionHelps(doc, result.added, result.children, exactLive),
      () => compactedRecently(doc.live, this.now()),
    );
    const verdict: 'ok' | 'full' | 'compact' = growth.full ? 'full' : growth.hard ? 'compact' : 'ok';
    // `full` refuses this frame only: the page without it may be small (a refused 3 MiB paste), so the API's page-full
    // mark is left to the exact measures (`measured`, the load).
    if (verdict === 'compact') this.needsCompaction(doc, growth.reason!, userId, true);
    if (verdict !== 'ok' && this.mode === 'enforce') return verdict; // refused: the counts stay those of the page without it
    doc.structs = structs;
    doc.liveChildren = Math.max(doc.liveChildren, result.children);
    if (exactLive !== undefined) {
      // the exact count (the shadow holds this frame) replaces the estimate until the next growth, so the walk does not
      // repeat on every frame until the next probe
      doc.liveStructs = exactLive;
      doc.structsAtMeasure = structs;
    }
    // Past a soft cap: requested for the next unload (a children soft cap: compaction keeps every live child, so it
    // never helps, and `compactionHelps` reads the children too).
    const soft = capVerdict(
      [
        { reason: 'structs', n: structs, cap: this.caps.structs, grew: false },
        { reason: 'client_ids', n: clients, cap: this.caps.clientIds, grew: false },
      ],
      () => this.compactionHelps(doc),
    );
    if (soft.reason !== null) this.needsCompaction(doc, soft.reason, userId, false);
    return verdict;
  }

  /**
   * #827: would a compaction bring the page, plus `frameStructs` structs and an element of `frameChildren` live
   * children (a refused frame's growth: room for that editor's work), back under the soft caps? Compaction keeps the live
   * structs (at most: the rebuild merges runs), every live child and one client id. Read from the counts measured
   * exactly at the last rebuild, mirror or probe, plus every struct counted since (growth is taken as live, so the
   * estimate errs toward page-full; the refused frame dirties the shadow, and the rebuild the next frame makes measures
   * again). O(1).
   */
  private compactionHelps(doc: DocGuard, frameStructs = 0, frameChildren = 0, exactStructs?: number): boolean {
    // An unload can compact only a page whose row bytes are covered: otherwise a drain would close everyone for a
    // compaction that never runs (and the resent frame would drain it again on every reload). Such a page is page-full.
    if (!this.rowCovered(doc.live)) return false;
    const structs = exactStructs ?? doc.liveStructs + Math.max(0, doc.structs - doc.structsAtMeasure) + frameStructs;
    return compactionWouldHelp({ structs, children: Math.max(doc.liveChildren, frameChildren) }, this.caps);
  }

  /** #827: measure what a compaction of `shadow` (the page, exactly) would keep. O(structs); never on the frame path. */
  private measureLive(doc: DocGuard, shadow: Y.Doc): void {
    const live = liveStructure(shadow);
    doc.liveStructs = live.structs;
    doc.liveChildren = live.children;
    doc.structsAtMeasure = doc.structs;
  }

  /**
   * #827: the page needs compaction. `hard` drains it now (closes every socket 1013, so it unloads and compacts) when a
   * compaction can start and the guard enforces; otherwise compaction waits for the next unload (before compaction is
   * armed, during another's, or within the per-page interval). Logged once per request. Never throws.
   */
  private needsCompaction(doc: DocGuard, reason: CompactionReason, userId: string | null, hard: boolean): void {
    try {
      // Only when an unload could compact it (`rowCovered`: covered row bytes, no build of them failed for good): a
      // probe, step or deadline drain of a page that cannot compact would close everyone again on every interval. #840:
      // a failed build never stops an order heal (its page is closed to joiners until it heals; the interval bounds it).
      const drain = hard && this.mode === 'enforce' && canStartCompaction(pageIdOf(doc.live) ?? '') && this.rowCovered(doc.live, reason);
      const request = { reason, userId, drain };
      if (requestCompaction(doc.live, request)) {
        logCompactionRequested(pageIdOf(doc.live), request, { structs: doc.structs, clientIds: doc.shadow?.store.clients.size, steps: doc.steps }, this.compactionLog);
      }
      if (drain) this.drain(doc.live);
    } catch {
      // the guard's own bookkeeping: never a reason to fail the frame path
    }
  }

  /** #827: close every socket connection of `live` 1013 with the compacting reason, so the page unloads and compacts. */
  private drain(live: GuardDocument): void {
    for (const connection of live.getConnections?.() ?? []) {
      try {
        connection.webSocket?.close(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
      } catch {
        // already closing
      }
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
   * The frame applied to the shadow inside the conflict-scan meter (#816), and (#827) under the frame deadline, innermost,
   * so the meter's own `finally` runs after a timeout. A trip or a meter failure throws out of Yjs's stack, before the
   * item it was replaying integrates; the scope says which, never the error's identity. A timeout skipped Yjs's
   * cleanup (`shadow._transaction` stays set): that shadow is thrown away.
   */
  private applyToShadow(
    doc: DocGuard,
    payload: Uint8Array,
    userId: string,
    pre: PrePass,
    own: (client: number) => boolean,
    attested: ReadonlyMap<number, Attested>,
  ): ShadowResult {
    const shadow = doc.shadow!;
    const store = shadow.store;
    const pendingBefore = pendingRanges(store);
    // #827: the struct arrays this apply can change, their lengths now (the store's struct count moves by their deltas).
    const tracked = new Map<number, number>();
    for (const ids of [pre.clients, pre.reaches, pendingBefore.keys()]) for (const client of ids) tracked.set(client, lengthOf(store, client));
    const clientsBefore = store.clients.size;
    const scan = new ConflictScan(shadow, this.mode === 'enforce');
    const failed = (violation: Violation, log?: RefusalLog): ShadowResult => ({
      violation,
      binds: new Map(),
      applied: false,
      log,
      reportOnly: [],
      added: 0,
      children: 0,
      structDelta: 0,
      clientsBefore,
      clientsAfter: clientsBefore,
      steps: scan.steps,
      suspect: false,
      unclear: false,
      changes: false,
    });
    let out: Inspection | null = null;
    let applied: Y.Transaction | null = null;
    const pendingAtStart = pendingStateOf(store);
    try {
      this.meter.metered(scan, () =>
        this.runWithDeadline(
          () =>
            Y.transact(
              shadow,
              (tr) => {
                applied = tr;
                Y.applyUpdate(shadow, payload, INSPECT); // V1, as y-protocols reads Step2 and Update
                out = this.inspectTransaction(doc, tr, userId, own, pendingBefore, pre.clients, tracked, attested);
              },
              INSPECT,
              false,
            ),
          this.deadlines.frame,
        ),
      );
    } catch (err) {
      doc.dirty = true;
      doc.dirtiedBy = userId;
      if (isDeadlineExceeded(err)) {
        doc.shadow = null; // cut mid-transaction: never reused
        return { ...failed({ rule: 'apply-deadline' }), timedOut: true };
      }
      if (scan.trip !== null) return failed({ rule: 'conflict-scan' }, { steps: scan.trip.steps });
      return failed({ rule: 'internal' }, scan.failure !== null ? { stage: 'conflict-scan' } : undefined);
    }
    const found = out as Inspection | null;
    if (found === null) return failed({ rule: 'internal' });
    let structDelta = 0;
    for (const [client, before] of tracked) structDelta += lengthOf(store, client) - before;
    for (const [client, mid] of found.extra) structDelta += lengthOf(store, client) - mid;
    const result: ShadowResult = {
      violation: found.violation,
      ...(found.log ? { log: found.log } : {}),
      binds: found.binds,
      proven: found.proven,
      applied: true,
      reportOnly: found.reportOnly,
      added: found.added,
      children: found.children,
      structDelta,
      clientsBefore,
      clientsAfter: store.clients.size,
      steps: scan.steps,
      suspect: found.suspect,
      unclear: found.unclear,
      changes: applied === null || encodingChanged(applied, pendingAtStart),
      relayed: found.relayed,
      relayFailed: found.relayFailed,
    };
    // Report mode: the meter counted past the cap and threw nothing; the frame is logged as it would have been refused.
    if (scan.trip !== null) return { ...result, violation: { rule: 'conflict-scan' }, log: { steps: scan.steps } };
    return result;
  }

  /**
   * Inside the transaction, after the frame integrated and before any GC or merge. Runs under the frame deadline: it
   * reads the shadow and the guard's state and writes nothing outside its result (no log, no timer).
   */
  private inspectTransaction(
    doc: DocGuard,
    tr: Y.Transaction,
    userId: string,
    own: (client: number) => boolean,
    pendingBefore: Ranges,
    frameClients: Set<number>,
    tracked: Map<number, number>,
    attested: ReadonlyMap<number, Attested>,
  ): Inspection {
    const shadow = tr.doc;
    const store = shadow.store;
    const root = shadow.share.get('default');
    const touched = new Set<Y.AbstractType<any>>();
    const grew = new Set<Y.AbstractType<any>>();
    const newTypes: Y.AbstractType<any>[] = [];
    const binds = new Map<number, string>();
    const proven = new Set<number>();
    const reportOnly: Violation[] = [];
    const relayed = new Set<number>();
    const relayFailed = new Map<number, 'pending' | 'failed'>();
    let added = 0;
    let suspect = false;
    let unclear = false;
    const walk = { steps: SUSPECT_WALK_PER_FRAME };
    const result = (violation: Violation | null, log?: RefusalLog): Inspection => {
      let children = 0;
      for (const type of grew) children = Math.max(children, (type as Y.XmlFragment).length); // the root or an element
      const extra = new Map<number, number>();
      for (const client of tr.deleteSet.clients.keys()) if (!tracked.has(client)) extra.set(client, lengthOf(store, client));
      return { violation, ...(log ? { log } : {}), binds, proven, reportOnly, added, children, extra, suspect, unclear, relayed, relayFailed };
    };

    // #827: a delete outside `default` (the lineage epoch, the write ledger) first, before any other rule can return:
    // it is refused in every mode, so a report-only violation earlier in the frame must not mask it.
    let rootDelete = false;
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (!rootDelete && struct instanceof Y.Item && rootOf(struct.parent as Y.AbstractType<any>) !== root) rootDelete = true;
    });
    if (rootDelete) return result({ rule: 'root' });

    // #827: new clocks come only from the frame's structs and the pending structs it releases (never O(ids)).
    const clients = new Set(frameClients);
    for (const client of pendingBefore.keys()) clients.add(client);
    for (const client of clients) {
      const structs = store.clients.get(client);
      const before = tr.beforeState.get(client) ?? 0;
      if (!structs || Y.getState(store, client) <= before) continue;
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        added++;
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
            if (!doc.awarenessOnly.has(client)) return result({ rule: 'foreign-client' });
            // The owner has only announced the id so far: its own Step2 may still be on the way while a peer relays its
            // lost structs (the mirror race after a lost lifetime). #842: such a relay lands only where it equals what
            // the owner itself sent in a frame refused here (its claim, compared before this step: `attested`), so
            // co-editors whose frames each carry another's unproven id no longer block each other. An attested clock
            // binds nothing and proves nothing, and falls through to every rule below (never `continue`). Any other
            // new clock here is never applied: `unresolved` makes the sender retry.
            const att = attested.get(client);
            if (att === undefined || struct.id.clock < att.from || struct.id.clock + struct.length > att.to) {
              return result({ rule: 'foreign-client' }, { stage: 'unproven-owner' });
            }
            relayed.add(client);
          } else if (doc.awarenessOnly.has(client)) {
            proven.add(client);
          }
        }
        if (!(struct instanceof Y.Item)) continue; // GC: no content, no parent
        const v = checkStruct(struct, root, touched, newTypes, grew);
        if (v && legacy) reportOnly.push(v);
        else if (v) return result(v);
        if (!suspect && !legacy) {
          // #840 blame, never a refusal: a contradiction makes the sender a suspect; a walk with no verdict, unclear
          const blame = contradictsOrigins(struct, walk);
          if (blame === true) suspect = true;
          else if (blame === null) unclear = true;
        }
      }
    }
    // #842: an attested relay must have integrated as compared: its R4 pieces deleted, its R6 GCs with their evidence.
    for (const client of relayed) {
      const verdict = verifyAttested(store, client, attested.get(client)!);
      if (verdict !== 'ok') {
        relayFailed.set(client, verdict);
        return result({ rule: 'foreign-client' }, { stage: 'unproven-owner' });
      }
    }
    // #840: a new item beside a neighbour of another parent or key: the item is checked against one parent while it
    // lives in another, and no replay or reload rebuilds that (parent-consistency.ts). Never written by an honest client.
    // Refused in every case, a legacy pending item's too. One shape, one rule: a foreign `left` is `cross-list` (the
    // per-struct rule above names it first; only a legacy item, report-only there, reaches here with it), and only a
    // foreign `right` beside a consistent `left` is `parent-split`.
    const split = parentConsistencyViolation(tr, clients);
    if (split) return result(split.side === 'left' ? { rule: 'cross-list' } : { rule: 'parent-split' });
    for (const type of newTypes) if (depthOf(type) > COLLAB_LIMITS.elementDepth) return result({ rule: 'element-depth' });

    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (struct instanceof Y.Item) touch(struct, touched); // every one is under `default` (checked above)
    });

    for (const type of touched) {
      if (type !== root && kindOf(type) !== 'element') continue;
      if (!isVisible(type)) continue;
      const check = checkElement(type as Y.XmlElement);
      if (check.ok || check.empty) continue; // an emptied container loses nothing (see content-rules.ts)
      if (doc.legacyInvalid.has(idOf(type))) continue; // invalid before this frame, already deleted on every open
      return result(check.violation!);
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
    return result(null);
  }

  private docFor(live: GuardDocument): DocGuard {
    const known = this.docs.get(live);
    if (known) return known;
    const created = new DocGuard(live, new RelayClaims(this.claimLedger));
    created.bindings.set(live.clientID, SERVER);
    ensureReplicaLog(live); // #840: attached at load (persistence); otherwise untrusted until a rebuild verifies it
    // The mirror NEVER throws: a throw in a Yjs 'update' listener stops every later listener and wedges the document's
    // cleanup for good. On any failure the shadow is only marked dirty (the next frame rebuilds it).
    const mirror = (update: Uint8Array, origin: unknown) => {
      // #827: a connection's update is the echo of a frame this guard accepted and already applied to the shadow
      // (Hocuspocus applies one only after its beforeHandleMessage resolved). One with no such frame outstanding was
      // never inspected: the shadow no longer equals live.
      if (isTransactionOrigin(origin) && origin.source === 'connection') {
        if (created.pendingEchoes === 0 && created.shadow !== null && !created.dirty) {
          created.dirty = true;
          created.dirtiedBy = SERVER;
        }
        return;
      }
      const shadow = created.shadow;
      if (!shadow || created.dirty) return;
      if (hasUnappliedFrames(live)) {
        // #840: a server-local update landed between a frame's accept and its apply (a microtask gap). The shadow holds
        // that frame already, live does not: applied here, the two would integrate in different orders, and Yjs does not
        // commute crafted frames. The next frame rebuilds in live's order (the replay log records both as live applied them).
        created.dirty = true;
        created.dirtiedBy = SERVER;
        return;
      }
      try {
        // #827: a server-local update (an API write, a Redis-relayed or reconcile update) is bounded too; live already
        // holds it, so a timeout is never a refusal: the shadow is dropped and the page compacts.
        this.runWithDeadline(() => Y.applyUpdate(shadow, update, MIRROR), this.deadlines.mirror);
        created.structs = structCount(shadow.store); // O(ids): server writes are rare
        this.measureLive(created, shadow); // O(structs), as rare
        // The cap rule on the exact counts (an API append can cross a cap, a replace can bring the page back under), on
        // the next turn: a drain closes sockets, never from inside a Yjs listener.
        setImmediate(() => {
          if (!created.destroyed && created.shadow === shadow && !created.dirty) this.measured(created, false, 'structs');
        });
      } catch (err) {
        created.shadow = null;
        created.dirty = true;
        created.dirtiedBy = SERVER; // a server-caused rebuild is charged to no one
        if (isDeadlineExceeded(err)) setImmediate(() => this.needsCompaction(created, 'mirror_deadline', null, true));
      }
    };
    live.on('update', mirror);
    live.once('destroy', () => {
      live.off('update', mirror);
      created.destroyed = true;
      created.probeTimer?.cancel();
      created.probeTimer = null;
      created.shadow = null;
      created.claims.clear(); // #842: its bytes go back to the process budget
      this.docs.delete(live);
    });
    this.docs.set(live, created);
    return created;
  }

  private ensureShadow(doc: DocGuard): ShadowState {
    if (doc.unavailable) return 'unavailable';
    if (doc.overBounds) {
      // The rebuild tripped, so the page waits on a compaction. When its request could not drain then (not armed yet,
      // within the interval, another in flight), ask again: `needsCompaction` upgrades it to a drain once one can start.
      // Otherwise an idle socket (a reader) would keep the page resident, and its writers waiting, for good.
      if (!isDraining(doc.live)) this.needsCompaction(doc, compactionRequest(doc.live)?.reason ?? 'rebuild_deadline', null, true);
      return 'compacting';
    }
    if (doc.diverged) {
      // #840: likewise, until the page heals (a compaction from live).
      if (!isDraining(doc.live)) this.needsCompaction(doc, 'order_divergence', null, true);
      return 'diverged';
    }
    // #827: no O(ids) state comparison: every live change reaches the mirror, which marks the shadow dirty unless it
    // applied it or it is the echo of an inspected frame; a frame accepted but never applied is caught at the flush.
    if (doc.shadow && !doc.dirty) return 'ready';
    return this.rebuild(doc);
  }

  /**
   * The shadow from live plus the frames accepted but not yet applied: exactly what live will hold. #827: built as a
   * load, under the step budget (W_MAX, the walk steps a full load of the page makes) and the load deadline, so it
   * also measures the page. A page past either cannot be replicated: it compacts, and until then its writers wait.
   * The first build's audit runs in the same bounded call and is committed only once the build succeeded.
   *
   * #840: a reload of live is kept only when it strict-equals live (it is then exact, and the replay log's new
   * checkpoint). Otherwise live's own inputs are replayed (exact-replica-registry.ts) under their own bounds, and the
   * replay must strict-equal live (the tripwire) before the in-flight frames go on top. Without a trusted log, past its
   * caps, or when the replay fails or differs, no exact shadow exists: the page is `diverged` until it heals.
   */
  private rebuild(doc: DocGuard): ShadowState {
    if (doc.unavailable) return 'unavailable';
    const live = doc.live;
    let state: Uint8Array;
    try {
      state = Y.encodeStateAsUpdate(live);
    } catch {
      return this.markUnavailable(doc); // a live document Yjs cannot encode (a legacy value too deep for lib0's encoder)
    }
    const started = this.cpuNow();
    const inflight = doc.inflight;
    const audit = !doc.audited;
    const fresh = () => new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter });
    let shadow = fresh();
    shadow.getXmlFragment('default');
    const scan = new ConflictScan(shadow, this.mode === 'enforce', this.caps.steps);
    let built: { exact: boolean; audited: Audit | null };
    try {
      built = this.meter.metered(scan, () =>
        this.runWithDeadline(() => {
          Y.applyUpdate(shadow, state, MIRROR);
          if (strictOrderDiff(shadow, live) !== null) return { exact: false, audited: null };
          for (const frame of inflight) Y.applyUpdate(shadow, frame, MIRROR);
          return { exact: true, audited: audit ? auditShadow(shadow) : null };
        }, this.deadlines.load),
      );
    } catch (err) {
      doc.shadow = null;
      doc.dirty = true;
      if (!isDeadlineExceeded(err) && scan.trip === null) return this.markUnavailable(doc);
      doc.overBounds = true;
      doc.steps = scan.trip?.steps ?? scan.steps;
      this.needsCompaction(doc, scan.trip !== null ? 'load_steps' : 'rebuild_deadline', null, true);
      return 'compacting';
    }
    if (built.exact) {
      doc.episode = null; // #840: live reloads into itself: any instability episode is over
      attachReplicaLog(live, state); // reload-stable: this encoding rebuilds live exactly
      // With nothing in flight that reload is exactly what a joiner's Step2 builds: the join check is answered.
      if (inflight.length === 0) doc.verified = `${mutationGeneration(live)}:${doc.accepted}`;
    } else {
      // #840: the reload is not live's order. Replay live's own inputs instead.
      const log = replicaLogOf(live);
      if (!log || log.overCap()) return this.diverge(doc, log ? 'log_over_cap' : untrustedOutcome(replicaLogDistrust(live)), started);
      const replica = fresh();
      replica.getXmlFragment('default');
      const replay = new ConflictScan(replica, this.mode === 'enforce', this.caps.steps + EXACT_REPLICA_CAPS.maxSteps);
      try {
        built = this.meter.metered(replay, () =>
          this.runWithDeadline(() => {
            log.rebuild({}, replica);
            if (strictOrderDiff(replica, live) !== null) return { exact: false, audited: null };
            for (const frame of inflight) Y.applyUpdate(replica, frame, MIRROR);
            return { exact: true, audited: audit ? auditShadow(replica) : null };
          }, this.deadlines.load),
        );
      } catch {
        return this.diverge(doc, 'replay_failed', started); // a trip, the deadline, or Yjs refusing its own log
      }
      if (!built.exact) return this.diverge(doc, 'tripwire', started);
      shadow = replica;
    }
    doc.shadow = shadow;
    doc.dirty = false;
    doc.dirtiedBy = null;
    doc.structs = structCount(shadow.store);
    doc.steps = scan.steps; // the reload's walk: what a load of the page costs
    this.measureLive(doc, shadow);
    // The replaced shadow is gone, and so is any reason to reserve its client id: one binding per rebuild otherwise.
    const replaced = doc.shadowBinding;
    if (replaced !== null && replaced !== live.clientID && doc.bindings.get(replaced) === SERVER) doc.bindings.delete(replaced);
    doc.shadowBinding = null;
    if (!doc.bindings.has(shadow.clientID)) {
      doc.bindings.set(shadow.clientID, SERVER);
      doc.shadowBinding = shadow.clientID;
    }
    if (built.audited) this.commitAudit(doc, built.audited);
    this.measured(doc, scan.trip !== null, 'load_steps'); // report mode counts past the budget
    return 'ready';
  }

  /**
   * #840: no exact shadow can be built for this document. Its writers wait (1013) and its joiners too; the page drains
   * to heal (a compaction from live) as soon as one can start. Logged, and the suspects struck.
   */
  private diverge(doc: DocGuard, outcome: string, started: number): ShadowState {
    doc.shadow = null;
    doc.dirty = true;
    doc.diverged = true;
    distrustReplicaLog(doc.live, outcome);
    this.unstable(doc, 'rebuild', outcome, this.cpuNow() - started);
    return 'diverged';
  }

  /**
   * #840: the page's order differs from what a reload (or its replay) builds. Each current suspect is struck (two strikes
   * on a page within the hour hold that user's writer frames there), once per instability episode (`DocGuard.episode`),
   * the line is logged naming them all, and the page heals: a drain when a compaction can start (#827's per-page
   * interval bounds them), else on the next unload.
   */
  private unstable(doc: DocGuard, where: OrderDivergenceWhere, outcome: string, ms: number): void {
    const now = this.now();
    const within = (users: Map<string, number>) => [...users].filter(([, at]) => now - at <= ORDER_SUSPECT_WINDOW_MS).map(([user]) => user);
    // No suspect: the users no walk could clear stand in (a contradiction hidden past the walk cap is still theirs).
    const found = within(doc.suspects);
    const suspects = found.length > 0 ? found : within(doc.unclear);
    doc.suspects.clear();
    doc.unclear.clear();
    const page = doc.live.name ?? '';
    const epoch = epochOrNull(doc.live);
    if (doc.episode === null || doc.episode.epoch !== epoch) doc.episode = { epoch, struck: new Set() };
    for (const user of suspects) {
      if (doc.episode.struck.has(user)) continue; // struck once this episode; the line below still names them
      doc.episode.struck.add(user);
      const budget = this.budgetOf(user, page);
      budget.strikes = budget.strikes.filter((at) => now - at < ORDER_STRIKE_WINDOW_MS);
      budget.strikes.push(now);
      if (budget.strikes.length >= ORDER_STRIKES_TO_HOLD) budget.heldUntil = now + ORDER_HOLD_MS;
    }
    this.divergence(doc, where, outcome, ms, suspects);
    this.needsCompaction(doc, 'order_divergence', suspects[0] ?? null, true);
  }

  /** #840: the COLLAB_ORDER_DIVERGENCE line (rate-limited with the guard's other lines). Never throws. */
  private divergence(doc: DocGuard, where: OrderDivergenceWhere, outcome: string, ms: number, suspects: readonly string[]): void {
    try {
      // No shadow (a lazy join, or one just dropped): the guard's count is unmeasured, so live's own (O(client ids)).
      const structs = doc.shadow !== null ? doc.structs : structCount(doc.live.store);
      logOrderDivergence({ page: pageIdOf(doc.live) ?? null, where, structs, ms, suspects, outcome }, false, this.divergenceLog);
    } catch {
      // a log line is never a reason to fail
    }
  }

  /**
   * #827: after an exact measure of the page (a rebuild, a probe, a mirrored server write), the one cap rule
   * (`capVerdict`): over the step budget drains; past a hard structure cap drains when compaction helps, else marks the
   * page full (its visible content is too big, or it was compacted within the interval); near a cap requests. The
   * page-full mark follows the verdict, so a page measured back under its caps takes API growth again.
   */
  private measured(doc: DocGuard, over: boolean, overReason: CompactionReason): void {
    if (over) return this.needsCompaction(doc, overReason, null, true);
    const verdict = capVerdict(
      [
        { reason: 'load_steps', n: doc.steps, cap: this.caps.steps },
        { reason: 'structs', n: doc.structs, cap: this.caps.structs },
        { reason: 'client_ids', n: doc.shadow?.store.clients.size ?? 0, cap: this.caps.clientIds },
        { reason: 'children', n: doc.liveChildren, cap: this.caps.children },
        { reason: 'structs', n: doc.liveStructs, cap: this.caps.compactLive, hardOnly: true },
      ],
      () => this.compactionHelps(doc),
      () => compactedRecently(doc.live, this.now()),
    );
    markPageFull(doc.live, verdict.full, pageFullUntil(doc.live, verdict));
    if (verdict.reason !== null) this.needsCompaction(doc, verdict.reason, null, verdict.hard);
  }

  private markUnavailable(doc: DocGuard): ShadowState {
    // Fail closed, logged once: every frame to this document is refused until it unloads.
    doc.unavailable = true;
    doc.shadow = null;
    this.logger.warn(`COLLAB_SHADOW_UNAVAILABLE ${JSON.stringify({ pageId: pageIdOf(doc.live) })}`);
    return 'unavailable';
  }

  /** First build only: the report-only audit of the stored content (legacy rows), computed by `auditShadow`. */
  private commitAudit(doc: DocGuard, audit: Audit): void {
    doc.audited = true;
    doc.legacyPending = audit.legacyPending;
    for (const id of audit.legacyInvalid) doc.legacyInvalid.add(id);
    if (doc.legacyInvalid.size) {
      this.logger.warn(`COLLAB_STORED_CONTENT_INVALID ${JSON.stringify({ pageId: pageIdOf(doc.live), elements: doc.legacyInvalid.size, rules: audit.rules })}`);
    }
  }

  private scheduleFlush(doc: DocGuard): void {
    if (doc.flushScheduled) return;
    doc.flushScheduled = true;
    setImmediate(() => {
      doc.flushScheduled = false;
      settleAcceptedFrames(doc.live); // #840: one accepted and never applied leaves the replay log unsure
      doc.inflight.length = 0;
      doc.pendingEchoes = 0;
      const targets = doc.targets.splice(0);
      // Every accepted frame has applied by now. A shadow still ahead of live means one did not: rebuild before trusting
      // it. #827: checked on the clocks each frame's structs end at, O(frame clients), never every id the page holds.
      if (!doc.shadow || doc.dirty) return;
      for (const target of targets) {
        for (const [client, end] of target) {
          if (Y.getState(doc.live.store, client) < end) {
            doc.dirty = true;
            return;
          }
        }
      }
    });
  }

  /**
   * #827: the probe, armed by accepted growth: PROBE_DEBOUNCE_MS after it, and at most one per PROBE_MIN_INTERVAL_MS per
   * document. So continuous typing probes every interval, and a load-order inversion or reorder (which no cap sees: a
   * one-struct frame can make every later load walk millions of steps) is caught within one.
   */
  private scheduleProbe(doc: DocGuard, userId: string): void {
    doc.writersSinceProbe.add(userId);
    if (doc.probeTimer !== null || doc.probeQueued || doc.destroyed) return;
    const now = this.now();
    const at = Math.max(now + PROBE_DEBOUNCE_MS, doc.lastProbeAt + PROBE_MIN_INTERVAL_MS);
    doc.probeTimer = this.schedule(() => {
      doc.probeTimer = null;
      this.enqueueProbe(doc);
    }, at - now);
  }

  /** One probe per macrotask, process-wide: probes due together never stack into one stall. */
  private enqueueProbe(doc: DocGuard): void {
    if (doc.destroyed || doc.probeQueued) return;
    doc.probeQueued = true;
    this.probeQueue.push(doc);
    if (this.probeDraining) return;
    this.probeDraining = true;
    const next = () => {
      const due = this.probeQueue.shift();
      if (due) {
        due.probeQueued = false;
        try {
          this.probe(due);
        } catch {
          // never out of a timer
        }
      }
      if (this.probeQueue.length) setImmediate(next);
      else this.probeDraining = false;
    };
    setImmediate(next);
  }

  /**
   * #827: load the shadow's encoding into a scratch document under the step budget and the probe deadline, and measure
   * it. The scratch document is then dropped: NEVER swapped in as the shadow (a reload can order concurrent structs
   * unlike live). Its cost is charged to everyone who grew the page since the last probe. Over the budget, or out of
   * time: the page drains and compacts. Returns false when there was nothing to probe (the next rebuild measures).
   * #840: the reload is also compared strictly with live: equal, it is the replay log's new checkpoint; different, the
   * page is reload-unstable (what a joiner or a restart would build is not live) and heals.
   */
  private probe(doc: DocGuard): boolean {
    const writers = [...doc.writersSinceProbe];
    doc.writersSinceProbe.clear();
    doc.lastProbeAt = this.now();
    if (doc.shadow !== null && replicaLogNeedsReverify(doc.live)) {
      doc.dirty = true; // the next frame or join rebuilds and re-verifies it (charged to that user)
      doc.dirtiedBy = null;
    }
    const shadow = doc.shadow;
    if (doc.destroyed || !shadow || doc.dirty) return false;
    const workStarted = this.now();
    const started = this.cpuNow();
    const checked = this.reloadCheck(doc, this.deadlines.probe);
    const ms = this.cpuNow() - started;
    for (const writer of writers) this.chargeCpu(writer, ms, workStarted);
    doc.steps = checked.steps;
    doc.structs = structCount(shadow.store); // exact again: frame deltas only approximate a split's merge
    this.measureLive(doc, shadow);
    this.measured(doc, checked.verdict === 'over', 'probe');
    if (checked.verdict === 'unstable') this.unstable(doc, 'probe', 'unstable', ms);
    return true;
  }

  /**
   * #840: a reload of the shadow (what a joiner, a restart or a compaction builds), under the step budget and `deadline`,
   * compared strictly with live when every accepted frame has applied (the shadow is live then; stable, its encoding
   * becomes the replay log's checkpoint). With frames in flight, a joiner may build either order: a reload of live plus
   * the frames (4.7.1 encodes its Step2 after they apply) or a reload of live with the frames applied on top. So both
   * must hold: a reload of the shadow equals the shadow, and a reload of live equals live (then a checkpoint too). `over`:
   * a reload tripped, ran out of time, or Yjs failed on its own encoding (fail closed).
   */
  private reloadCheck(doc: DocGuard, deadline: number): { verdict: 'stable' | 'unstable' | 'over' | 'unencodable'; steps: number } {
    // No shadow (checkJoin on a page no writer has touched, nothing in flight): live itself.
    const inFlight = doc.shadow !== null && hasUnappliedFrames(doc.live);
    const first = this.reloadEquals(doc, doc.shadow ?? doc.live, inFlight ? doc.shadow! : doc.live, deadline);
    const checked = first.verdict !== 'stable' || !inFlight ? first : { verdict: this.reloadEquals(doc, doc.live, doc.live, deadline).verdict, steps: first.steps };
    if (checked.verdict === 'stable') doc.episode = null; // #840: a stable verdict ends the instability episode
    return checked;
  }

  /**
   * Does a reload of `source`'s encoding strict-equal `target` (`source` itself, or live when the shadow is live)?
   * Metered, the deadline innermost. Equal to live: that encoding is the replay log's new checkpoint.
   */
  private reloadEquals(doc: DocGuard, source: Y.Doc, target: Y.Doc, deadline: number): { verdict: 'stable' | 'unstable' | 'over' | 'unencodable'; steps: number } {
    const scratch = new Y.Doc({ gc: doc.live.gc, gcFilter: doc.live.gcFilter });
    const scan = new ConflictScan(scratch, true, this.caps.steps);
    let state: Uint8Array;
    let stable: boolean;
    try {
      state = Y.encodeStateAsUpdate(source);
    } catch {
      return { verdict: source === doc.live ? 'unencodable' : 'over', steps: 0 }; // live: as rebuild (markUnavailable)
    }
    try {
      stable = this.meter.metered(scan, () =>
        this.runWithDeadline(() => {
          Y.applyUpdate(scratch, state);
          return strictOrderDiff(scratch, target) === null;
        }, deadline),
      );
    } catch {
      return { verdict: 'over', steps: scan.trip?.steps ?? scan.steps };
    }
    if (stable && target === doc.live) attachReplicaLog(doc.live, state);
    return { verdict: stable ? 'stable' : 'unstable', steps: scan.steps };
  }

  /**
   * #840: a SyncStep1 is a join: 4.7.1 answers it with a Step2 encoded from live once the hooks resolved, so the joiner
   * builds a reload of live plus the frames in flight, which is the shadow (or, encoded before they apply, a reload of
   * live with them on top). It is answered only when a reload of the shadow strict-equals it, and with frames in flight
   * a reload of live strict-equals live (`reloadCheck`): checked once per change of what a joiner can get (live's
   * generation, which moves only on a transaction that can change its encoding, and the accepted frames that can), under
   * the meter and the probe deadline, and charged to the joiner (who waits, 1013, while in collab CPU debt). An unstable
   * page answers 1013 (try later) and heals; so does one that cannot be verified (over the bounds, or no exact shadow).
   * Both definite answers are kept for their key: an unstable one (`unstableAt`) answers the next joiners 1013 with no
   * reload and asks for the heal again, until the page changes or heals.
   */
  private checkJoin(frame: GuardFrame): void {
    const doc = this.docFor(frame.document);
    const userId = String(frame.context?.user?.id ?? '');
    this.reverify(doc, userId); // a log distrusted for its caps, the total or frame order: its shadow is rebuilt first
    // A page no writer has touched has no shadow, and a join needs none: with nothing in flight its Step2 is live's
    // encoding, so live itself is checked (a page only readers open never builds, or mirrors into, a page-sized copy).
    const lazy = doc.shadow === null && !doc.dirty && !doc.unavailable && !doc.overBounds && !doc.diverged && !hasUnappliedFrames(doc.live);
    const key = `${mutationGeneration(doc.live)}:${doc.accepted}`;
    if (doc.verified === key && (doc.shadow !== null || lazy) && !doc.dirty) return;
    if (doc.unstableAt === key && !doc.dirty) {
      // Found unstable at this very key, and its heal could not start yet: what a joiner gets has not changed, so the
      // answer has not either. No reload (a reconnect would otherwise charge the joiner a page-sized reload each time);
      // the heal is asked for again (a drain once one can start). Never struck or logged again (the episode was).
      this.needsCompaction(doc, 'order_divergence', null, true);
      return this.tryLater(frame, 'order_divergence'); // throws unless report mode
    }
    if (!this.take(this.budgetFor(frame, true).cpu, USER_COLLAB_CPU_BURST_MS, CPU_MS_REFILL_EVERY_MS, 0)) {
      this.tryLater(frame, 'user_collab_cpu'); // throws unless report mode
    }
    const workStarted = this.now();
    const started = this.cpuNow();
    let othersMs = 0;
    try {
      const shadowed = lazy ? { ready: 'ready' as ShadowState, othersMs: 0 } : this.readyShadow(doc, userId);
      othersMs = shadowed.othersMs;
      if (shadowed.ready === 'unavailable') return; // nothing to verify against (a legacy page Yjs cannot encode)
      if (shadowed.ready === 'compacting') return this.compacting(frame);
      if (shadowed.ready === 'diverged') return this.tryLater(frame, 'order_divergence');
      if (doc.verified === key) return; // the rebuild it just ran reloaded live with nothing in flight: stable
      const checkStarted = this.cpuNow();
      const checked = this.reloadCheck(doc, this.deadlines.probe);
      if (checked.verdict === 'unencodable') return void this.markUnavailable(doc);
      if (checked.verdict === 'stable') {
        doc.verified = key;
        return;
      }
      if (checked.verdict === 'over') this.needsCompaction(doc, 'load_steps', userId, true);
      else {
        // Only a definite answer is kept: `over` depends on timing (a later reload may fit its deadline).
        doc.unstableAt = key;
        this.unstable(doc, 'join', 'unstable', this.cpuNow() - checkStarted);
      }
      this.tryLater(frame, 'order_divergence'); // throws unless report mode
    } finally {
      this.chargeCpu(userId, this.cpuNow() - started - othersMs, workStarted);
    }
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
  /**
   * #827: whether `rule` refuses (enforce mode), or only logs (report mode). ALWAYS_ENFORCED rules refuse in every
   * mode.
   */
  private enforces(rule: string): boolean {
    return this.mode === 'enforce' || ALWAYS_ENFORCED.has(rule);
  }

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
    if (!this.enforces(violation.rule)) return;
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
 * write at every bound id, so on an honest page it follows only an id collision. An editor of the page can still force
 * one across a reload (#845): bindings are not persisted, so while the document reloads it writes at the victim's id
 * before the victim reconnects; the victim's Yjs then regenerates its id on the relayed write, the new id stays unbound
 * here, and the editor can forge at it (silently dropping the victim's later edits) or claim it by awareness. Closing it
 * needs the client to re-announce under its new id, or persisted bindings (#793) restored awareness-only-like so that
 * owner claims cover them.
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
 * The stateless rules, on the decoded frame, for every struct live does not already hold (`heldByLive`), and the client
 * ids of those structs (Skips excepted: they integrate nothing). A held struct is a no-op in Yjs, so neither its content
 * nor its client id is judged; a struct that is only partly held is judged whole (the shadow then sees the tail Yjs
 * integrates). The decode and the delete-order rule still cover the WHOLE frame, held structs or not: a delete set is
 * judged by its wire order alone. `Y.decodeUpdate` keeps that order (`readDeleteSet` appends, it never sorts). #827:
 * also the other client ids the apply can split or merge (dependencies, delete ranges, and every struct's own client,
 * held or not: tracking only), and the clock each client's structs end at.
 *
 * #842: two shape rules on the WHOLE frame, held structs included, never written by an honest encoder (0 of either in
 * a fuzz of 19,990 honest updates):
 * - `zero-length`: a struct of any kind (GC and Skip too) that takes no clock. A zero-length GC was accepted before:
 *   after it `Y.encodeStateAsUpdate` throws (the page can no longer be stored or answered), and a frame of them is
 *   hundreds of MiB of heap (update-guard.spec.ts).
 * - `client-blocks`: a struct section whose block count is not its number of distinct clients. Yjs's apply keeps only
 *   the LAST block of a repeated client while `Y.decodeUpdate` returns them all, so a reader of the decoded frame (the
 *   rules here, an owner-claim comparison) would see structs Yjs never integrates.
 * Both refuse in every mode (ALWAYS_ENFORCED), ahead of any other pre-pass violation but `root`.
 */
function prePass(payload: Uint8Array, live: Y.Doc): PrePass {
  const clients = new Set<number>();
  const reaches = new Set<number>();
  const ends = new Map<number, number>();
  const structClients = new Set<number>();
  let decoded: { structs: Array<Y.Item | Y.GC | Y.Skip>; ds: { clients: Map<number, Array<{ clock: number; len: number }>> } };
  let blocks: number;
  try {
    decoded = Y.decodeUpdate(payload) as typeof decoded;
    blocks = decoding.readVarUint(decoding.createDecoder(payload)); // V1: the struct section's block count comes first
  } catch {
    // e.g. a lib0 `readAny` value deep enough to overflow the decoder
    return { violation: { rule: 'undecodable' }, clients, reaches, ends, decoded: null, structClients };
  }
  let violation: Violation | null = null;
  let rootWrite = false; // #827: a write outside `default` wins over any other violation (refused in every mode)
  // #842: so do the two shape rules (ALWAYS_ENFORCED): a report-only violation earlier in the frame never masks them
  let shape: Violation | null = null;
  const states = new Map<number, number>();
  for (const struct of decoded.structs) structClients.add(struct.id.client);
  if (blocks !== structClients.size) shape = { rule: 'client-blocks' };
  for (const struct of decoded.structs) {
    if (!(struct.length > 0)) shape ??= { rule: 'zero-length' }; // before the Skip and held skips
    if (struct instanceof Y.Skip) continue;
    const client = struct.id.client;
    const end = struct.id.clock + struct.length;
    if (end > (ends.get(client) ?? 0)) ends.set(client, end);
    reaches.add(client);
    if (struct instanceof Y.Item) {
      if (struct.origin) reaches.add(struct.origin.client);
      if (struct.rightOrigin) reaches.add(struct.rightOrigin.client);
      const parent = struct.parent as unknown;
      if (parent instanceof Y.ID) reaches.add(parent.client);
    }
    if (heldByLive(struct, live, states)) continue; // a remount's resend: Yjs integrates none of it
    clients.add(client);
    if (struct instanceof Y.Item) {
      violation ??= structRule(struct);
      if (typeof struct.parent === 'string' && struct.parent !== 'default') rootWrite = true;
    }
  }
  for (const client of decoded.ds.clients.keys()) reaches.add(client);
  return {
    violation: rootWrite ? { rule: 'root' } : (shape ?? violation ?? deleteOrder(decoded.ds.clients)),
    clients,
    reaches,
    ends,
    decoded,
    structClients,
  };
}

/**
 * Does live already hold all of `struct`, so that Yjs never integrates it? Yjs's `integrateStructs` integrates a struct
 * only when `offset === 0 || offset < length` (offset = live's state for its client minus its clock); this is the exact
 * negation, so a zero-length struct at the state's clock is NOT held (Yjs integrates it, and it is judged). A y-indexeddb
 * remount honestly resends such structs: the server's own `__ccc_write_idem` ledger entries (pruned ones too, as
 * ContentDeleted), other users' content, and stored pre-#781 content a stateless rule refuses (the shadow treats that as
 * legacy).
 *
 * Sound because a Y.Doc's state only grows during its lifetime: held when checked means never integrated by any later
 * apply of this frame. A shadow ahead of live changes nothing here (live is what is read): a struct live lacks is simply
 * not held, and is judged as before. Two side effects of a held struct remain, both the shadow's as for any struct:
 * - The decode itself: Yjs's `readClientsStructRefs` calls `doc.get(<root name>)` for a struct whose parent is a root
 *   name, before the clock check, creating that root. So a struct naming a root live does not hold is never held (it
 *   is judged `root`), or a frame of held structs could grow live's `share` without bound.
 * - `getMissing` (splits, a pending park, a throw on a forged parent id): the shadow's `internal` and `unresolved`.
 * Not counted: structs in live's pending store (`getState` excludes them). Those are judged as before.
 */
function heldByLive(struct: Y.Item | Y.GC, live: Y.Doc, states: Map<number, number>): boolean {
  const { client, clock } = struct.id;
  let state = states.get(client);
  if (state === undefined) states.set(client, (state = Y.getState(live.store, client)));
  if (!(state > clock && clock + struct.length <= state)) return false;
  const parent = struct instanceof Y.Item ? (struct.parent as unknown) : null;
  return typeof parent !== 'string' || live.share.has(parent);
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
function checkStruct(
  item: Y.Item,
  root: Y.AbstractType<any> | undefined,
  touched: Set<Y.AbstractType<any>>,
  newTypes: Y.AbstractType<any>[],
  grew: Set<Y.AbstractType<any>>,
): Violation | null {
  const parent = item.parent as Y.AbstractType<any>;
  const parentKind = kindOf(parent);
  if (rootOf(parent) !== root) return { rule: 'root' };
  // An item is linked after its `left`, into that neighbour's list. Yjs derives the parent FROM the left for a struct
  // with an origin (getMissing), but the tail of a partly known struct (Item.integrate, offset > 0) is linked after the
  // same client's previous clock while keeping the parent getMissing resolved (from the wire, or from the ORIGINAL
  // origin). So a crafted frame names one list and lands in another, one this guard never checks: a string in the root
  // list wedges every browser and the store; a keyed tail writes another element's attribute and deletes the value it
  // follows. A remote integration never does it honestly: that previous clock is the same original struct (same parent,
  // same key), and `right` is always `left.right` or the head of the item's own list, so `left` is the one to read.
  // Before the `deleted` return: a tail deleted on arrival is still linked into the foreign list.
  const left = item.left;
  if (left !== null && (left.parent !== parent || left.parentSub !== item.parentSub)) return { rule: 'cross-list' };
  // #816: Yjs never writes a keyed item with a rightOrigin (typeMapSet and redo leave it null; a split copies it), and one
  // re-walks its key's history. Checked here, not in the pre-pass: an item with an origin or a rightOrigin takes its key
  // from them at integrate time (Yjs's readItem reads parentSub only when both are null), so the wire never shows it.
  if (item.parentSub !== null && item.rightOrigin !== null) return { rule: 'attr-kind' };
  if (isKeyedSplit(item)) return { rule: 'keyed-split' };
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
  grew.add(parent); // #827: a live child added to `parent` (E, the children cap)
  return null;
}

/**
 * #847: a live keyed item must be one standalone value (Yjs's typeMapSet writes one; a later value of the key deletes
 * it). One holding several values, split by a later delete, wedges live's transaction cleanup (Item.gc on the split);
 * one with a right neighbour is not the key's value. Read inside the frame's transaction, on every item it created.
 */
export const isKeyedSplit = (item: Y.Item): boolean => item.parentSub !== null && !item.deleted && (item.length !== 1 || item.right !== null);

/**
 * #840 blame (never a refusal): does `item`'s placement contradict what its sender knew when it wrote it? Yjs places an
 * item after its origin and before its rightOrigin, with only items its sender never saw (concurrent ones) between: so
 * a list end met before the origin (walking left) or the rightOrigin (walking right) contradicts (true), and so does
 * one of the sender's own earlier items between them (it knew those). Each walk stops after SUSPECT_WALK items, and
 * `budget.steps` bounds the frame's walks in all: either way with no verdict (null, `unclear`: a concurrent paste of a
 * thousand paragraphs honestly lands between an item and its rightOrigin, and so does padding meant to hide a
 * contradiction). Own items are per client id, never per user: two tabs of one user are concurrent replicas.
 */
function contradictsOrigins(item: Y.Item, budget: { steps: number }): boolean | null {
  if (item.parentSub !== null) return false;
  let verdict: boolean | null = false;
  for (const leftward of [true, false]) {
    const target = leftward ? item.origin : item.rightOrigin;
    let s = leftward ? item.left : item.right;
    for (let n = 0; ; n++) {
      if (s === null) {
        if (target !== null) return true; // the list ended first: origin and item cross
        break;
      }
      if (target !== null && holds(s, target)) break;
      if (s.id.client === item.id.client && s.id.clock < item.id.clock) return true;
      if (n >= SUSPECT_WALK || --budget.steps < 0) {
        verdict = null; // the other direction may still contradict
        break;
      }
      s = leftward ? s.left : s.right;
    }
    if (budget.steps < 0) return verdict;
  }
  return verdict;
}
const holds = (s: Y.Item, id: Y.ID): boolean => s.id.client === id.client && s.id.clock <= id.clock && id.clock < s.id.clock + s.length;

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

/** #840: live's lineage epoch, or null when its lineage root is malformed (an episode is per epoch). */
function epochOrNull(live: Y.Doc): number | null {
  try {
    return lineageEpoch(live);
  } catch {
    return null;
  }
}

/** #840: the divergence outcome for a rebuild that needed the replay log and found it untrusted. */
function untrustedOutcome(why: string | null): string {
  if (why === LOG_OVER_CAP) return 'log_over_cap';
  if (why === LOG_OVER_TOTAL) return 'log_over_total';
  return 'log_untrusted';
}

/** #827: structs in a store, O(client ids): only where Yjs already paid O(structs) (a rebuild, a probe, a mirror). */
function structCount(store: Y.Doc['store']): number {
  let n = 0;
  for (const structs of store.clients.values()) n += structs.length;
  return n;
}
const lengthOf = (store: Y.Doc['store'], client: number): number => store.clients.get(client)?.length ?? 0;

/** #827: the lineage epoch a connection's client claims for its copy (`?cccEpoch`); absent = 0, malformed = NaN. */
function clientEpoch(params: GuardFrame['requestParameters']): number {
  const raw = params?.get('cccEpoch');
  if (raw === null || raw === undefined) return 0;
  return /^(0|[1-9][0-9]{0,14})$/.test(raw) ? Number(raw) : Number.NaN;
}

/** The report-only audit of a freshly built shadow (legacy rows): pure, so it runs inside the rebuild's bounds. */
type Audit = { legacyPending: Ranges; legacyInvalid: string[]; rules: Record<string, number> };
function auditShadow(shadow: Y.Doc): Audit {
  const legacyInvalid = new Set<string>();
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
      legacyInvalid.add(idOf(type)); // a legacy table past the extent bound: reported, its edits not refused for it
      rules['table-size'] = (rules['table-size'] ?? 0) + 1;
    }
    if (!check.ok && !check.empty) {
      legacyInvalid.add(idOf(type));
      rules[check.violation!.rule] = (rules[check.violation!.rule] ?? 0) + 1;
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
      legacyInvalid.add(idOf(parent));
      rules[`cascade:${check.violation!.rule}`] = (rules[`cascade:${check.violation!.rule}`] ?? 0) + 1;
    }
    if (parent !== root) {
      gone.add(parent);
      queue.push(parent);
    }
  }
  return { legacyPending: pendingRanges(shadow.store), legacyInvalid: [...legacyInvalid], rules };
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
