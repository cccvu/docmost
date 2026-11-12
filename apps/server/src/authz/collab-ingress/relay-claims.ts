/**
 * CCC collab integration — NOT upstream Docmost code (#842, ADR 0036 §4).
 *
 * Owner claims: how a relay of another user's lost structs, at an id that user has only announced (`awarenessOnly`),
 * is told apart from a forgery there. After a crash lost unsaved edits, each reconnecting co-editor's Step2 carries the
 * others' lost structs, and each frame is refused `unresolved` (`unproven-owner`): nobody's frame lands, so nobody's id
 * is ever proven. Content identity is the only proof a relay can carry (Yjs ids are equivocable, signatures do not
 * survive Step2's re-encoding), so the guard keeps what the OWNER itself sent: when an owner's frame is refused
 * `unproven-owner`, its own structs (and the frame's delete set) are recorded as a claim, and a later relay at that
 * owner's id lands only if every struct it carries there equals, position and content, piece by piece, what the claim
 * holds (`compareRelay`, rules R0–R6 below). A matched relay binds nothing and proves nothing, and every content rule
 * still judges it (update-guard.ts).
 *
 * The rules, for each id x the relay writes new clocks at that is awareness-only and bound to another user U holding a
 * valid claim (`RelayClaims.attest`):
 *   R0 every decoded struct at x ending past live's state is checked (never "some struct covers each clock");
 *   R1 a struct starting below live's state never matches (Yjs takes the tail's parent from the wire start origin);
 *   R2 relay ⊆ claim: every relayed clock lies inside the claim's structs;
 *   R3 positions per piece [p, q), both sides walked in clock order: origin (normalized: the struct's own at its start,
 *      else ID(x, p-1)), rightOrigin, and parent/parentSub only where both of those are null (Yjs reads them from the
 *      wire only then);
 *   R4 a relay piece that ends deleted (ContentDeleted, or covered by the relay's own non-empty half-open delete range)
 *      matches any claim content when R3 holds: the owner's insert, then a writer's delete. The apply must leave it
 *      deleted (`verifyAttested`);
 *   R5 a live relay piece needs a live claim piece (no owner-deleted text is resurrected) of the same class and content:
 *      String by raw slice (never Yjs's splice), Any by a strict deep equal (prototype, own-key order, Object.is),
 *      Format by key and value, Type by type and nodeName; anything else never;
 *   R6 a claim GC matches only a relay GC. A relay GC over a claimed Item matches only with evidence AFTER the apply:
 *      the claimed struct's origin or rightOrigin resolves to a GC, or the parent Yjs would derive for it is no longer
 *      visible (never wire-only: a forged GC beside a deleted item in a live parent would turn later inserts into GC).
 * A failed R3/R5/R6 comparison burns the relayer for that claim instance (the guess budget: one comparison per relayer
 * per claim, so a mismatch is never an oracle for more than one guess). Missing coverage (R1/R2) or no claim burns
 * nothing.
 *
 * Bounds (limits.ts): a claim is native bytes, one per (user, document), the latest replacing the earlier; per user and
 * per process totals are budgeted BEFORE a claim is stored, and a full budget records nothing (never an eviction). A
 * claim is used only within CLAIM_TTL_MS, while its owner's binding and awareness-only state at x hold, and while the
 * guard says the owner may still write (update-guard.ts). Dropped on prove, TTL, or the document's destroy.
 *
 * Pure: no Hocuspocus, no logger, no clock of its own. Never throws: any exception is "no match" (today's `unresolved`).
 */
import * as Y from 'yjs';
import { CLAIM_BYTES_PER_USER, CLAIM_BYTES_TOTAL, CLAIM_TTL_MS } from './limits';

/** Why an id was not attested: no valid claim, R1/R2 coverage, a failed comparison (burned now), or burned earlier. */
export type ClaimOutcome = 'none' | 'uncovered' | 'mismatch' | 'burned';
export type RecordOutcome = 'recorded' | 'full' | 'none';

type DecodedStruct = Y.Item | Y.GC | Y.Skip;
type DeleteRanges = ReadonlyMap<number, ReadonlyArray<{ clock: number; len: number }>>;
/** A V1 update as `Y.decodeUpdate` returns it. */
export interface DecodedFrame {
  structs: ReadonlyArray<DecodedStruct>;
  ds: { clients: DeleteRanges };
}

/** R6: the start fields of a claimed Item a relay replaced with GC, checked after the apply (`verifyAttested`). */
export interface GcEvidence {
  origin: Y.ID | null;
  rightOrigin: Y.ID | null;
  parent: Y.ID | string | null;
}

/** An id whose relayed clocks [from, to) matched `owner`'s claim, with the checks the apply must still pass. */
export interface Attested {
  owner: string;
  from: number;
  to: number;
  /** R4: clock ranges [start, end) the relay ends deleted: every struct there must be deleted after the apply. */
  deleted: Array<[number, number]>;
  /** R6: relay GCs over claimed Items: each needs evidence after the apply. */
  evidence: GcEvidence[];
}

export interface AttestQuery {
  relayer: string;
  frame: DecodedFrame;
  /** The ids the frame writes new clocks at that are awareness-only and bound to another user. */
  candidates: Iterable<number>;
  /** Live's state (its clock) at a client. */
  stateOf(client: number): number;
  ownerOf(client: number): string | undefined;
  isAwarenessOnly(client: number): boolean;
  /** May `owner`'s claim still be used (the guard's policy: not narrowed to read-only on this document). */
  ownerMayWrite(owner: string): boolean;
  now: number;
}

export interface AttestResult {
  attested: Map<number, Attested>;
  failed: Map<number, ClaimOutcome>;
}

export interface OwnerClaim {
  readonly owner: string;
  readonly ids: ReadonlySet<number>;
  bytes: Uint8Array | null;
  readonly size: number;
  readonly at: number;
  /** Relayers that failed a comparison against THIS instance (the guess budget). */
  readonly burned: Set<string>;
  live: boolean;
  readonly home: RelayClaims;
}

/**
 * The process's claim bytes, per user and in total, and their expiry queue (claims are recorded in time order, so the
 * oldest is at the front: pruning is amortized O(1), never a scan). One per guard (one guard per process).
 */
export class ClaimLedger {
  private used = 0;
  private readonly byUser = new Map<string, number>();
  private queue: OwnerClaim[] = [];
  private head = 0;

  constructor(
    readonly perUser: number = CLAIM_BYTES_PER_USER,
    readonly total: number = CLAIM_BYTES_TOTAL,
    readonly ttlMs: number = CLAIM_TTL_MS,
  ) {}

  /** Bytes held, in total or by one user (specs and diagnostics). */
  bytes(user?: string): number {
    return user === undefined ? this.used : (this.byUser.get(user) ?? 0);
  }

  /** Release every claim older than the TTL (and forget released ones at the front). */
  prune(now: number): void {
    while (this.head < this.queue.length) {
      const claim = this.queue[this.head];
      if (claim.live && now - claim.at <= this.ttlMs) break;
      if (claim.live) claim.home.release(claim);
      this.head++;
    }
    if (this.head > 64 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }

  /** Room for `bytes` more of `user`'s? Taken when there is; nothing is taken (or evicted) when there is not. */
  reserve(user: string, bytes: number): boolean {
    const mine = this.byUser.get(user) ?? 0;
    if (mine + bytes > this.perUser || this.used + bytes > this.total) return false;
    this.byUser.set(user, mine + bytes);
    this.used += bytes;
    return true;
  }

  release(user: string, bytes: number): void {
    const left = (this.byUser.get(user) ?? 0) - bytes;
    if (left > 0) this.byUser.set(user, left);
    else this.byUser.delete(user);
    this.used = Math.max(0, this.used - bytes);
  }

  enqueue(claim: OwnerClaim): void {
    this.queue.push(claim);
  }
}

/** One document's claims, by owner (held on the guard's DocGuard, so dropped with the document). */
export class RelayClaims {
  private readonly claims = new Map<string, OwnerClaim>();

  constructor(private readonly ledger: ClaimLedger) {}

  /**
   * Record `owner`'s claim from its refused frame: its own structs at `ids` (every other client in the frame dropped by
   * a state vector of MAX) and the frame's whole delete set. Replaces the owner's earlier claim on this document (a new
   * instance: a fresh guess budget). `full` when a bound has no room: nothing is recorded and nothing evicted.
   */
  record(owner: string, ids: ReadonlySet<number>, payload: Uint8Array, frameClients: Iterable<number>, now: number): RecordOutcome {
    try {
      if (!ids.size) return 'none';
      this.ledger.prune(now);
      const others = new Map<number, number>();
      for (const client of frameClients) if (!ids.has(client)) others.set(client, Number.MAX_SAFE_INTEGER);
      const own = Y.diffUpdate(payload, Y.encodeStateVector(others));
      this.drop(owner);
      const size = own.buffer.byteLength; // by capacity: what it retains
      if (!this.ledger.reserve(owner, size)) return 'full';
      const claim: OwnerClaim = { owner, ids: new Set(ids), bytes: own, size, at: now, burned: new Set(), live: true, home: this };
      this.claims.set(owner, claim);
      this.ledger.enqueue(claim);
      return 'recorded';
    } catch {
      return 'none';
    }
  }

  /** Drop `owner`'s claim (its frame landed: its ids are proven). */
  drop(owner: string): void {
    const claim = this.claims.get(owner);
    if (claim) this.release(claim);
  }

  /** Drop every claim (the document is destroyed). */
  clear(): void {
    for (const claim of [...this.claims.values()]) this.release(claim);
  }

  /** `relayer` failed a check against `owner`'s current claim after the apply (R4/R6): no more comparisons for it. */
  burn(owner: string, relayer: string): void {
    this.claims.get(owner)?.burned.add(relayer);
  }

  /** Whether `owner` holds a claim here (specs and diagnostics). */
  has(owner: string): boolean {
    return this.claims.has(owner);
  }

  /** @internal ClaimLedger's expiry. */
  release(claim: OwnerClaim): void {
    if (!claim.live) return;
    claim.live = false;
    claim.bytes = null;
    if (this.claims.get(claim.owner) === claim) this.claims.delete(claim.owner);
    this.ledger.release(claim.owner, claim.size);
  }

  /**
   * For each candidate id, the clocks the relay may write there (`attested`), or why not (`failed`). A failed R3/R5/R6
   * comparison burns the relayer for that claim instance. Never throws.
   */
  attest(q: AttestQuery): AttestResult {
    const attested = new Map<number, Attested>();
    const failed = new Map<number, ClaimOutcome>();
    try {
      this.ledger.prune(q.now);
    } catch {
      // bookkeeping only
    }
    const decoded = new Map<OwnerClaim, DecodedFrame>();
    for (const x of q.candidates) {
      let outcome: ClaimOutcome | Attested;
      try {
        outcome = this.attestOne(q, x, decoded);
      } catch {
        outcome = 'none';
      }
      if (typeof outcome === 'string') failed.set(x, outcome);
      else attested.set(x, outcome);
    }
    return { attested, failed };
  }

  private attestOne(q: AttestQuery, x: number, decoded: Map<OwnerClaim, DecodedFrame>): ClaimOutcome | Attested {
    const owner = q.ownerOf(x);
    if (owner === undefined || owner === q.relayer || !q.isAwarenessOnly(x)) return 'none';
    const claim = this.claims.get(owner);
    if (!claim || !claim.live || claim.bytes === null || !claim.ids.has(x)) return 'none';
    if (q.now - claim.at > this.ledger.ttlMs || !q.ownerMayWrite(owner)) return 'none';
    if (claim.burned.has(q.relayer)) return 'burned';
    let own = decoded.get(claim);
    if (own === undefined) {
      own = Y.decodeUpdate(claim.bytes) as unknown as DecodedFrame;
      decoded.set(claim, own);
    }
    const verdict = compareRelay(q.frame, own, x, q.stateOf(x));
    if (verdict === 'mismatch') {
      claim.burned.add(q.relayer);
      return 'mismatch';
    }
    if (verdict === 'uncovered') return 'uncovered';
    return { owner, ...verdict };
  }
}

/**
 * R0–R6 at id `x`: does every struct `relay` carries at x past `liveState` equal what `claim` holds there? Run-length:
 * the relay's structs, the claim's structs and both delete sets at x are walked once, in clock order, split into pieces
 * at every boundary of any of them. Throws only on a malformed input (the caller treats a throw as no match).
 */
export function compareRelay(
  relay: DecodedFrame,
  claim: DecodedFrame,
  x: number,
  liveState: number,
): 'uncovered' | 'mismatch' | Omit<Attested, 'owner'> {
  // R0/R1: every struct at x ending past live's state, none of them starting below it, contiguous.
  const fresh: Array<Y.Item | Y.GC> = [];
  let next = liveState;
  for (const s of relay.structs) {
    if (s.id.client !== x) continue;
    if (!(s.length > 0)) return 'uncovered'; // a zero-length struct (the pre-pass refuses it first)
    if (s.id.clock + s.length <= liveState) continue; // held: Yjs integrates none of it
    if (s instanceof Y.Skip || s.id.clock !== next) return 'uncovered'; // R1 (a straddle), or a gap (it would pend)
    fresh.push(s as Y.Item | Y.GC);
    next = s.id.clock + s.length;
  }
  if (!fresh.length) return 'uncovered';
  // The claim's structs at x: contiguous, ascending (Skips are gaps: never covered).
  const own: DecodedStruct[] = [];
  for (const s of claim.structs) {
    if (s.id.client !== x) continue;
    if (!(s.length > 0) || (own.length && s.id.clock !== own[own.length - 1].id.clock + own[own.length - 1].length)) return 'uncovered';
    own.push(s);
  }
  const relayDeleted = new Cover(relay.ds.clients.get(x));
  const claimDeleted = new Cover(claim.ds.clients.get(x));
  const deleted: Array<[number, number]> = [];
  const evidence: GcEvidence[] = [];
  let lastEvidence: DecodedStruct | null = null;
  let j = 0;
  for (const r of fresh) {
    const end = r.id.clock + r.length;
    for (let p = r.id.clock; p < end; ) {
      while (j < own.length && own[j].id.clock + own[j].length <= p) j++;
      const c = own[j];
      if (c === undefined || c.id.clock > p || c instanceof Y.Skip) return 'uncovered'; // R2
      const rd = relayDeleted.at(p);
      const cd = claimDeleted.at(p);
      const q = Math.min(end, c.id.clock + c.length, rd.until, cd.until);
      const piece = comparePiece(r, c as Y.Item | Y.GC, p, x, q - p, rd.covered, cd.covered);
      if (piece === 'mismatch') return 'mismatch';
      if (piece === 'deleted') {
        const last = deleted[deleted.length - 1];
        if (last && last[1] === p) last[1] = q;
        else deleted.push([p, q]);
      } else if (piece === 'evidence' && lastEvidence !== c) {
        const item = c as Y.Item;
        evidence.push({ origin: item.origin, rightOrigin: item.rightOrigin, parent: (item.parent as Y.ID | string | null) ?? null });
        lastEvidence = c;
      }
      p = q;
    }
  }
  return { from: liveState, to: next, deleted, evidence };
}

/** One piece [p, p + len) of relay struct `r` against claim struct `c`. */
function comparePiece(
  r: Y.Item | Y.GC,
  c: Y.Item | Y.GC,
  p: number,
  x: number,
  len: number,
  relayDsCovers: boolean,
  claimDsCovers: boolean,
): 'ok' | 'deleted' | 'evidence' | 'mismatch' {
  if (!(c instanceof Y.Item)) return r instanceof Y.GC ? 'ok' : 'mismatch'; // R6: a claim GC only against a relay GC
  if (!(r instanceof Y.Item)) return 'evidence'; // R6: a relay GC over a claimed Item, decided after the apply
  if (!samePosition(r, c, p, x)) return 'mismatch'; // R3
  if (r.content instanceof Y.ContentDeleted || relayDsCovers) return 'deleted'; // R4
  if (c.content instanceof Y.ContentDeleted || claimDsCovers) return 'mismatch'; // R5: never resurrect
  return sameContent(r, c, p - r.id.clock, p - c.id.clock, len) ? 'ok' : 'mismatch';
}

/** R3: the normalized origin, the rightOrigin, and parent/parentSub only where both are null. */
function samePosition(r: Y.Item, c: Y.Item, p: number, x: number): boolean {
  const ro = p === r.id.clock ? r.origin : Y.createID(x, p - 1);
  const co = p === c.id.clock ? c.origin : Y.createID(x, p - 1);
  if (!sameId(ro, co) || !sameId(r.rightOrigin, c.rightOrigin)) return false;
  if (ro !== null || r.rightOrigin !== null) return true; // Yjs derives parent and key from the origins
  return sameParent(r.parent, c.parent) && r.parentSub === c.parentSub;
}

const sameId = (a: Y.ID | null, b: Y.ID | null): boolean =>
  a === null || b === null ? a === b : a.client === b.client && a.clock === b.clock;

function sameParent(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  return a instanceof Y.ID && b instanceof Y.ID && sameId(a, b);
}

/** R5: same content class, and equal content over the piece (`ro`/`co`: its offset in each struct). */
function sameContent(r: Y.Item, c: Y.Item, ro: number, co: number, len: number): boolean {
  const a = r.content;
  const b = c.content;
  if (a.constructor !== b.constructor) return false;
  if (a instanceof Y.ContentString) return a.str.slice(ro, ro + len) === (b as Y.ContentString).str.slice(co, co + len);
  if (a instanceof Y.ContentAny) {
    const other = (b as Y.ContentAny).arr;
    if (ro + len > a.arr.length || co + len > other.length) return false;
    for (let i = 0; i < len; i++) if (!strictEqual(a.arr[ro + i], other[co + i], 0)) return false;
    return true;
  }
  if (a instanceof Y.ContentFormat) return a.key === (b as Y.ContentFormat).key && strictEqual(a.value, (b as Y.ContentFormat).value, 0);
  if (a instanceof Y.ContentType) {
    const ta: unknown = a.type;
    const tb: unknown = (b as Y.ContentType).type;
    if ((ta as object).constructor !== (tb as object).constructor) return false;
    if ((ta as object).constructor === Y.XmlText) return true;
    return (ta as object).constructor === Y.XmlElement && (ta as Y.XmlElement).nodeName === (tb as Y.XmlElement).nodeName;
  }
  return false; // JSON, Binary, Embed, Doc, Deleted (R4/R5 handle it): never
}

/** Deep equality with nothing coerced: the same prototype, the same own keys in the same order, leaves by Object.is. */
export function strictEqual(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 256 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!strictEqual((a as Record<PropertyKey, unknown>)[ka[i]], (b as Record<PropertyKey, unknown>)[kb[i]], depth + 1)) return false;
  }
  return true;
}

/** One client's delete ranges, non-empty and half-open, merged: walked with a pointer (callers ask in ascending order). */
class Cover {
  private readonly ranges: Array<[number, number]> = [];
  private i = 0;
  constructor(raw: ReadonlyArray<{ clock: number; len: number }> | undefined) {
    const sorted = (raw ?? []).filter((d) => d.len > 0).map((d) => [d.clock, d.clock + d.len] as [number, number]);
    sorted.sort((a, b) => a[0] - b[0]);
    for (const [s, e] of sorted) {
      const last = this.ranges[this.ranges.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else this.ranges.push([s, e]);
    }
  }
  /** Whether clock `p` is deleted, and up to where that answer holds. */
  at(p: number): { covered: boolean; until: number } {
    while (this.i < this.ranges.length && this.ranges[this.i][1] <= p) this.i++;
    const range = this.ranges[this.i];
    if (range === undefined) return { covered: false, until: Infinity };
    return range[0] <= p ? { covered: true, until: range[1] } : { covered: false, until: range[0] };
  }
}

/**
 * After the apply, inside the frame's shadow transaction: did the attested clocks at `x` integrate as compared? Every
 * R4 range must be deleted in `store`, and every R6 GC must have its evidence. `pending`: the clocks did not all
 * integrate (a missing dependency: the frame is refused either way). Never throws.
 */
export function verifyAttested(store: Y.Doc['store'], x: number, att: Attested): 'ok' | 'pending' | 'failed' {
  try {
    if (Y.getState(store, x) < att.to) return 'pending';
    const structs = store.clients.get(x)!;
    for (const [start, end] of att.deleted) {
      for (let i = Y.findIndexSS(structs, start); i < structs.length && structs[i].id.clock < end; i++) {
        if (!structs[i].deleted) return 'failed';
      }
    }
    for (const ev of att.evidence) if (!hasEvidence(store, ev)) return 'failed';
    return 'ok';
  } catch {
    return 'failed';
  }
}

/**
 * R6: would the owner's Item have integrated as a GC, or deleted, where the relay put a GC? Yjs (Item.getMissing) makes
 * an item a GC when its left (origin) or right (rightOrigin) is a GC, and otherwise takes its parent from the left, else
 * the right, else the wire; an item whose parent is no longer visible ends deleted. Unknown ids are no evidence.
 */
function hasEvidence(store: Y.Doc['store'], ev: GcEvidence): boolean {
  const left = ev.origin ? structAt(store, ev.origin) : null;
  const right = ev.rightOrigin ? structAt(store, ev.rightOrigin) : null;
  if ((ev.origin && left === null) || (ev.rightOrigin && right === null)) return false;
  if (left instanceof Y.GC || right instanceof Y.GC) return true;
  let parent: unknown;
  if (left) parent = (left as Y.Item).parent;
  else if (right) parent = (right as Y.Item).parent;
  else if (ev.parent instanceof Y.ID) {
    const holder = structAt(store, ev.parent);
    if (holder === null) return false;
    if (holder instanceof Y.GC) return true;
    const content = (holder as Y.Item).content;
    if (!(content instanceof Y.ContentType)) return true; // a type item garbage-collected to ContentDeleted
    parent = content.type;
  } else return false; // a root: always visible
  return parent instanceof Y.AbstractType && !visible(parent);
}

function structAt(store: Y.Doc['store'], id: Y.ID): Y.Item | Y.GC | null {
  const structs = store.clients.get(id.client);
  if (!structs || id.clock >= Y.getState(store, id.client)) return null;
  return structs[Y.findIndexSS(structs, id.clock)] as Y.Item | Y.GC;
}

function visible(type: Y.AbstractType<any>): boolean {
  for (let t = type; t._item !== null; t = t._item.parent as Y.AbstractType<any>) if (t._item.deleted) return false;
  return true;
}
