/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * What a compaction of a page keeps, whether that is under the soft caps, and the cap verdict (`capVerdict`): the one
 * rule shared by the update guard (a frame that grows the page, a rebuild, a probe, a mirrored server write) and the
 * load path (authz/page-write/compaction.ts, `loadStoredYdoc`), so a page is never drained or queued for a compaction
 * that cannot help it (one whose visible content, not its history, is what is too big), and every site agrees on the
 * boundaries and on page-full.
 */
import * as Y from 'yjs';
import type { CompactionReason } from '../page-write/compaction-registry';
import { COMPACT_MAX_LIVE_STRUCTS, softCap } from './doc-bounds';

/** A page's live structure: its non-deleted structs, and the most live children of one element. */
export interface LiveStructure {
  structs: number;
  children: number;
}

/**
 * What a compaction of `doc` keeps: its live (non-deleted) structs, and the most live children of one element (the
 * `default` root included; the children cap's count). Pure reads, O(structs): an explicit stack, never recursion.
 */
export function liveStructure(doc: Y.Doc): LiveStructure {
  let structs = 0;
  for (const array of doc.store.clients.values()) for (const struct of array) if (!struct.deleted) structs++;
  let children = 0;
  const root = doc.share.get('default');
  const stack: Y.AbstractType<any>[] = root ? [root] : [];
  while (stack.length) {
    const type = stack.pop()!;
    children = Math.max(children, type._length);
    for (let item = type._start; item !== null; item = item.right) {
      // Exactly Y.XmlElement (XmlHook extends Y.Map, XmlText extends Y.Text): the update guard's `kindOf` element.
      if (!item.deleted && item.content instanceof Y.ContentType && item.content.type.constructor === Y.XmlElement) {
        stack.push(item.content.type);
      }
    }
  }
  return { structs, children };
}

/**
 * Would a compaction bring a page of `live` structure under the soft caps, within what one build may rebuild? Compaction
 * keeps the live structs (at most: the rebuild merges runs), every live child and one client id, so the client-id cap
 * always helps and the structs and children caps decide. A page with more live structs than `compactLive`
 * (COMPACT_MAX_LIVE_STRUCTS: what a build fits in COMPACTION_DEADLINE_MS on production hardware) is not compacted for a
 * structure cap: past one it is page-full, and it never drains. (The live-struct cap itself is a hard-only measure of the
 * cap rule, so growth never takes a page past it; the step budget and the probe still compact by order.)
 */
export function compactionWouldHelp(live: LiveStructure, caps: { structs: number; children: number; compactLive?: number }): boolean {
  const compactLive = caps.compactLive ?? COMPACT_MAX_LIVE_STRUCTS;
  return live.structs <= compactLive && live.structs < softCap(caps.structs) && live.children < softCap(caps.children);
}

/** One per-page bound, measured. */
export interface CapMeasure {
  reason: CompactionReason;
  /** The measured count. */
  n: number;
  /** Its hard cap. */
  cap: number;
  /**
   * Whether it may count as past its hard cap (default true). The guard's frame check passes false for a measure the
   * frame did not grow: deletes always pass.
   */
  grew?: boolean;
  /**
   * A hard bound only: never a soft request (compaction cannot bring it down, e.g. the live structs it keeps). Past its
   * cap it is page-full whenever `helps()` says no.
   */
  hardOnly?: boolean;
}

/** What a cap verdict asks for. */
export interface CapVerdict {
  /** Request compaction for this reason (the first that crossed), or null. */
  reason: CompactionReason | null;
  /** A measure is past a hard cap that compaction fixes: drain now, when a compaction can start (the caller's call). */
  hard: boolean;
  /**
   * A measure is past a hard cap that compaction does not fix (the page's visible content is too big, or it was
   * compacted within the interval and is over again): page-full. Growth is refused; deletes and replaces pass.
   */
  full: boolean;
  /**
   * Some measure is page-full because compaction would not bring the page under the soft caps (its visible content).
   * False with `full` set: page-full only because it was compacted within the interval, which lapses.
   */
  contentFull: boolean;
}

/** Compaction rewrites the struct order, which is what a load's walk costs: a step cap always helps. */
const ORDER_REASONS: ReadonlySet<CompactionReason> = new Set<CompactionReason>(['load_steps']);

/**
 * #827: THE cap rule. Soft: a measure at or past `softCap(cap)` requests compaction for the next unload. Hard: past
 * `cap` (strictly, and only a measure that `grew`) drains now, or is page-full. A step measure is always compactable;
 * a structure measure (structs, client ids, children) only when `helps()` (compaction would bring the page under the
 * soft caps: `compactionWouldHelp` on what the caller measured) and, past its hard cap, only when the page was not
 * `recentlyCompacted()`. Both callbacks are lazy (each may cost O(structs)) and run at most once. A page-full page
 * requests compaction only for a step measure.
 */
export function capVerdict(
  measures: readonly CapMeasure[],
  helps: () => boolean,
  recentlyCompacted: () => boolean = () => false,
): CapVerdict {
  const near = measures.filter((m) => m.n >= softCap(m.cap) && (!m.hardOnly || m.n > m.cap));
  if (near.length === 0) return { reason: null, hard: false, full: false, contentFull: false };
  let helped: boolean | undefined;
  let recent: boolean | undefined;
  const orders = (m: CapMeasure) => ORDER_REASONS.has(m.reason);
  const softFixable = (m: CapMeasure) => orders(m) || (helped ??= helps());
  const hardFixable = (m: CapMeasure) => orders(m) || ((helped ??= helps()) && !(recent ??= recentlyCompacted()));
  const over = near.filter((m) => m.n > m.cap && m.grew !== false);
  const full = over.some((m) => !hardFixable(m));
  const contentFull = over.some((m) => !softFixable(m));
  const fixed = over.filter(hardFixable);
  const requested = fixed[0] ?? near.find((m) => (full ? orders(m) : softFixable(m)));
  return { reason: requested?.reason ?? null, hard: fixed.length > 0, full, contentFull };
}
