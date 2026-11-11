/**
 * CCC collab integration — NOT upstream Docmost code (#816, ADR 0036).
 *
 * The conflict-scan meter. To integrate an item, Yjs walks the structs between the item's `left` (origin) and its
 * `right` (rightOrigin) until a break (yjs 13.6.30 `Item.integrate`, Item.js:415-496). Honest edits send adjacent
 * origins, so the walk only crosses concurrent structs they had not seen; a crafted frame can make it cross the whole
 * document once per item (siblings at one origin with rising client ids, two clients, one client with distinct
 * rightOrigins, a rightOrigin left of the origin, a keyed history), which costs seconds to minutes in one synchronous
 * apply, paid again by live and by every browser. Nothing in Yjs or Hocuspocus bounds it.
 *
 * How: `installConflictScanMeter` wraps `Y.Item.prototype.integrate` once (idempotent, marked by a symbol). Inside a
 * `metered` scope for one document (the guard's shadow apply), the wrapper first REPLAYS the walks Yjs is about to make
 * for that item, read for read, using only the exported `compareIDs`, `getItem` and `createID` (never a splitting read):
 * the `offset > 0` left resolution (:416-422), the entry condition (:425), the keyed pre-walk (:440-442), the loop's
 * case 1, case 2 and break (:459-482), and the keyed reconnect walk (:489-494). It counts one step per iteration and
 * throws past CONFLICT_SCAN_STEPS_PER_ITEM steps for one item or CONFLICT_SCAN_STEPS_PER_FRAME for the scope, BEFORE
 * delegating, so Yjs never pays the walk. The trip is recorded on the scope (`trip`); the thrown value is only a way
 * out of Yjs's stack and is never recognized by identity. In report mode it counts and never throws.
 *
 * It fails closed: an unexpected error inside the replay is recorded (`failure`) and rethrown as a
 * ConflictScanMeterError, which the guard refuses as `internal`. The replay makes only the reads Yjs's loop makes, in the
 * same order, so it throws only where Yjs itself would. Outside a scope, or for another document, the wrapper is one
 * null check and never throws: live, the mirror, rebuilds and server writes are never metered. A yjs whose `integrate`
 * or exports are missing or changed shape refuses to install, and the guard's constructor (so the Nest boot) with it.
 * conflict-scan.spec.ts pins the source of `integrate` and the yjs version: re-diff the replay on any bump.
 */
import * as Y from 'yjs';

/**
 * Steps one item may walk. The largest honest walks the #816 bench measured (2–5 peers, offline runs of up to 500 ops,
 * 2000-paragraph pastes, reconnects) were 5,810 steps for one item and 176,000 for one frame: an offline run of 500
 * edits merged where another editor had pasted 2000 paragraphs, each item walking past the paste. One step costs Yjs
 * about 20–60 ns, so an item at this cap costs a few milliseconds.
 */
export const CONFLICT_SCAN_STEPS_PER_ITEM = 50_000;
/** Steps one frame may walk in total (all its items, pending structs released by it included): ~50 ms per apply. */
export const CONFLICT_SCAN_STEPS_PER_FRAME = 1_000_000;

type YModule = typeof Y;
type Trip = { cap: 'item' | 'frame'; steps: number };

/** One metered apply: its caps, its counts, and how it ended. */
export class ConflictScan {
  /** Steps walked so far (report mode keeps counting past a cap). */
  steps = 0;
  /** The most steps one item walked, and the steps of the last item replayed. */
  maxItem = 0;
  lastItem = 0;
  items = 0;
  /** The first cap exceeded, with the steps at that point. */
  trip: Trip | null = null;
  /** An unexpected error inside the replay (the scan then fails closed). */
  failure: unknown = null;
  constructor(
    readonly doc: Y.Doc,
    readonly enforce: boolean,
    readonly perItem: number = CONFLICT_SCAN_STEPS_PER_ITEM,
    readonly perFrame: number = CONFLICT_SCAN_STEPS_PER_FRAME,
  ) {}
}

/** An unexpected error inside the replay, rethrown so the frame is refused (`internal`), never applied unmetered. */
export class ConflictScanMeterError extends Error {
  constructor(readonly failure: unknown) {
    super('conflict-scan meter failed');
  }
}

export interface ConflictScanMeter {
  /** Run `fn` with `scan` active: items integrated into `scan.doc` are metered. The scope is cleared in a finally. */
  metered<T>(scan: ConflictScan, fn: () => T): T;
  /** The `integrate` the wrapper delegates to (the tripwire spec hashes its source). */
  readonly original: (transaction: Y.Transaction, offset: number) => void;
  isActive(): boolean;
}

const MARK = Symbol.for('ccc.collab-ingress.conflict-scan-meter');
/** The value thrown at a trip: a way out of Yjs's stack. The guard reads the trip from the scope, not from this. */
const BUDGET = Object.freeze({ cccConflictScan: 'budget' });

/**
 * Install the meter on `y` (the guard's own `yjs`), once. Throws, so the guard and the server refuse to start, when
 * `Item.prototype.integrate`, `compareIDs`, `getItem` or `createID` is missing or not the 2-argument function the replay
 * was written against.
 */
export function installConflictScanMeter(y: YModule = Y): ConflictScanMeter {
  const proto = (y as unknown as { Item?: { prototype?: Record<string | symbol, unknown> } }).Item?.prototype;
  const current = proto?.integrate as (((...a: unknown[]) => unknown) & { [MARK]?: ConflictScanMeter }) | undefined;
  if (typeof current === 'function' && current[MARK]) return current[MARK];
  const shapeOk = (f: unknown) => typeof f === 'function' && (f as (...a: unknown[]) => unknown).length === 2;
  const missing = [
    ['Item.prototype.integrate', current],
    ['compareIDs', y.compareIDs],
    ['getItem', y.getItem],
    ['createID', y.createID],
  ]
    .filter(([, f]) => !shapeOk(f))
    .map(([name]) => name);
  if (!proto || missing.length) {
    throw new Error(
      `CCC collab conflict-scan meter (#816, ADR 0036): yjs ${missing.join(', ') || 'Item'} is missing or changed shape, ` +
        'so collab frames cannot be bounded; refusing to start. Re-validate the replay in conflict-scan.ts against the new ' +
        'Item.integrate before upgrading yjs.',
    );
  }
  const original = current as unknown as (this: Y.Item, transaction: Y.Transaction, offset: number) => void;
  let active: ConflictScan | null = null;

  /** One step of `scan`'s walk for the current item; past a cap, record the trip and (enforce) leave Yjs's stack. */
  const over = (scan: ConflictScan, itemSteps: number): void => {
    const total = scan.steps + itemSteps;
    if (scan.trip === null && (itemSteps > scan.perItem || total > scan.perFrame)) {
      scan.trip = itemSteps > scan.perItem ? { cap: 'item', steps: itemSteps } : { cap: 'frame', steps: total };
    }
    if (scan.trip !== null && scan.enforce) throw BUDGET;
  };

  /** The walks `Item.integrate` is about to make for `item`, read for read; returns their step count. */
  const replay = (item: Y.Item, transaction: Y.Transaction, offset: number, scan: ConflictScan): number => {
    const store = transaction.doc.store;
    let left = item.left;
    let origin = item.origin;
    if (offset > 0) {
      // Item.js:416-419. clock + offset - 1 is the client's last integrated clock (integrateStructs' `offset`), so it is
      // the end of a struct: Yjs's getItemCleanEnd splits nothing there and returns what getItem returns.
      left = y.getItem(store, y.createID(item.id.client, item.id.clock + offset - 1)) as Y.Item;
      origin = left.lastId;
    }
    const right = item.right;
    const parent = item.parent as Y.AbstractType<any> | null;
    if (!parent) return 0; // Yjs integrates a GC instead
    let steps = 0;
    if ((!left && (!right || right.left !== null)) || (left && left.right !== right)) {
      let o: Y.Item | null;
      if (left !== null) {
        o = left.right;
      } else if (item.parentSub !== null) {
        o = parent._map.get(item.parentSub) || null;
        while (o !== null && o.left !== null) {
          over(scan, ++steps);
          o = o.left;
        }
      } else {
        o = parent._start;
      }
      const conflicting = new Set<Y.Item>();
      const beforeOrigin = new Set<Y.Item>();
      while (o !== null && o !== right) {
        over(scan, ++steps);
        beforeOrigin.add(o);
        conflicting.add(o);
        if (y.compareIDs(origin, o.origin)) {
          if (o.id.client < item.id.client) {
            left = o;
            conflicting.clear();
          } else if (y.compareIDs(item.rightOrigin, o.rightOrigin)) {
            break;
          }
        } else if (o.origin !== null && beforeOrigin.has(y.getItem(store, o.origin) as Y.Item)) {
          if (!conflicting.has(y.getItem(store, o.origin) as Y.Item)) {
            left = o;
            conflicting.clear();
          }
        } else {
          break;
        }
        o = o.right;
      }
    }
    // Item.js:489-494: an item that lands first in its key's history walks to the start of that history.
    if (left === null && item.parentSub !== null) {
      let r: Y.Item | null = parent._map.get(item.parentSub) || null;
      while (r !== null && r.left !== null) {
        over(scan, ++steps);
        r = r.left;
      }
    }
    return steps;
  };

  const charge = (scan: ConflictScan, item: Y.Item, transaction: Y.Transaction, offset: number): void => {
    let steps: number;
    try {
      steps = replay(item, transaction, offset, scan);
    } catch (err) {
      if (scan.enforce && scan.trip !== null) throw err; // the budget's own exit (report mode never throws one)
      scan.failure = err;
      throw new ConflictScanMeterError(err);
    }
    scan.steps += steps;
    scan.items++;
    scan.lastItem = steps;
    if (steps > scan.maxItem) scan.maxItem = steps;
  };

  const integrate = function (this: Y.Item, transaction: Y.Transaction, offset: number): void {
    const scan = active;
    if (scan !== null && transaction.doc === scan.doc) {
      // A failed or tripped scope stays failed: nothing more integrates into it unmetered.
      if (scan.failure !== null) throw new ConflictScanMeterError(scan.failure);
      if (scan.trip !== null && scan.enforce) throw BUDGET;
      charge(scan, this, transaction, offset);
    }
    return original.call(this, transaction, offset);
  };

  const meter: ConflictScanMeter = {
    metered<T>(scan: ConflictScan, fn: () => T): T {
      const previous = active;
      active = scan;
      try {
        return fn();
      } finally {
        active = previous;
      }
    },
    original,
    isActive: () => active !== null,
  };
  Object.defineProperty(integrate, MARK, { value: meter });
  proto.integrate = integrate;
  return meter;
}
