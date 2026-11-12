/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036).
 *
 * Order parity between two Yjs replicas. Yjs integrates some frames (crafted ones, and an honest grouped redo before
 * the patched `redoItem`, yjs #794/#823) into one order when applied incrementally and into another after a reload
 * (`applyUpdate(new Y.Doc(), encodeStateAsUpdate(doc))`). The bytes and `toJSON` cannot see it, so a shadow rebuilt by
 * reload can validate a frame in an order live does not have, and a reload can serve a joiner yet another order.
 *
 * `strictOrderDiff` says whether two replicas will make the same integration choices for any future frame. It is
 * STRICT, split boundaries included: a copy equal to live only up to merged runs (the same characters in the same
 * order, cut into different structs) was observed to diverge on the next frame, because an origin or rightOrigin that
 * splits a struct on one replica lands on a boundary on the other (S1 in the spec). It walks both replicas in lockstep
 * and allocates no per-struct arrays: every list chain and every key chain (tombstones included), recursing into the
 * types of live items, then the struct store's per-client boundaries and its pending state. Items under a deleted type
 * are compared by the store walk only: nothing can make them visible again.
 * `displacedItems` names the items whose relative order differs (outside a longest common subsequence), to blame
 * authors. `isReloadStable` is the compare against a reload of the document.
 *
 * It reads Yjs internals (`_start`, `_map`, `_length`, `store.clients`, `pendingStructs`, `pendingDs`, item fields).
 * order-parity.spec.ts pins the yjs version and those shapes: re-validate this file on any yjs bump.
 */
import * as Y from 'yjs';

/** The first difference found. Ids and structure only (no content, keys cut short): safe to log. */
export type OrderDiff = { path: string; kind: OrderDiffKind; detail: string };
export type OrderDiffKind =
  | 'typeLength'
  | 'chain'
  | 'id'
  | 'length'
  | 'deleted'
  | 'origin'
  | 'rightOrigin'
  | 'parentSub'
  | 'parent'
  | 'content'
  | 'store'
  | 'pending';

type Type = Y.AbstractType<any>;
/** Types still to compare: a's, b's, the root's name and the path (the root, or the root and the type's item id). */
type Pairs = Array<[Type | undefined, Type | undefined, string, string]>;
const NO_KEYS = new Map<string, Y.Item>();
const id = (i: Y.ID | null | undefined) => (i ? `${i.client}:${i.clock}` : '-');
const cut = (s: string) => (s.length > 32 ? `${s.slice(0, 32)}…` : s);
const leftmost = (item: Y.Item) => {
  while (item.left) item = item.left;
  return item;
};

export function strictOrderDiff(a: Y.Doc, b: Y.Doc): OrderDiff | null {
  // A missing root equals an empty one: the name is created by the first frame that writes it, on either replica.
  const stack: Pairs = [];
  for (const name of a.share.keys()) stack.push([a.share.get(name), b.share.get(name), cut(name), cut(name)]);
  for (const name of b.share.keys()) if (!a.share.has(name)) stack.push([undefined, b.share.get(name), cut(name), cut(name)]);
  while (stack.length) {
    const [ta, tb, root, path] = stack.pop()!;
    const d = typeDiff(ta, tb, root, path, stack);
    if (d) return d;
  }
  return storeDiff(a.store, b.store);
}

function typeDiff(ta: Type | undefined, tb: Type | undefined, root: string, path: string, stack: Pairs): OrderDiff | null {
  const la = ta?._length ?? 0;
  const lb = tb?._length ?? 0;
  if (la !== lb) return { path, kind: 'typeLength', detail: `a=${la} b=${lb}` };
  const d = chainDiff(ta, ta?._start ?? null, tb, tb?._start ?? null, null, root, path, stack);
  if (d) return d;
  const ma = ta?._map ?? NO_KEYS;
  const mb = tb?._map ?? NO_KEYS;
  for (const [key, ia] of ma) {
    const ib = mb.get(key);
    const d = chainDiff(ta, leftmost(ia), tb, ib ? leftmost(ib) : null, key, root, `${path}.${cut(key)}`, stack);
    if (d) return d;
  }
  for (const [key, ib] of mb) {
    if (!ma.has(key)) return chainDiff(ta, null, tb, leftmost(ib), key, root, `${path}.${cut(key)}`, stack);
  }
  return null;
}

/** One chain (a list, or one key's history), forward and in lockstep. */
function chainDiff(
  ta: Type | undefined,
  ia: Y.Item | null,
  tb: Type | undefined,
  ib: Y.Item | null,
  sub: string | null,
  root: string,
  path: string,
  stack: Pairs,
): OrderDiff | null {
  for (let i = 0; ia || ib; i++, ia = ia!.right, ib = ib!.right) {
    if (!ia || !ib) return { path, kind: 'chain', detail: `[${i}] a=${id(ia?.id)} b=${id(ib?.id)}` };
    const both = (kind: OrderDiffKind, va: unknown, vb: unknown): OrderDiff => ({ path: `${path}[${i}]`, kind, detail: `a=${va} b=${vb}` });
    if (ia.id.client !== ib.id.client || ia.id.clock !== ib.id.clock) return both('id', id(ia.id), id(ib.id));
    if (ia.length !== ib.length) return both('length', ia.length, ib.length);
    if (ia.deleted !== ib.deleted) return both('deleted', ia.deleted, ib.deleted);
    if (id(ia.origin) !== id(ib.origin)) return both('origin', id(ia.origin), id(ib.origin));
    if (id(ia.rightOrigin) !== id(ib.rightOrigin)) return both('rightOrigin', id(ia.rightOrigin), id(ib.rightOrigin));
    if (ia.parentSub !== ib.parentSub) return both('parentSub', ia.parentSub !== null, ib.parentSub !== null);
    // Parent consistency: an item reached from a type must belong to it (a crafted neighbour can claim another parent).
    if (ia.parent !== ta || ib.parent !== tb || ia.parentSub !== sub) return both('parent', ia.parent === ta, ib.parent === tb);
    const ca = ia.content;
    const cb = ib.content;
    if (ca.constructor !== cb.constructor || (ca instanceof Y.ContentType && ca.type.constructor !== (cb as Y.ContentType).type.constructor)) {
      return both('content', ca.getRef(), cb.getRef());
    }
    if (!ia.deleted && ca instanceof Y.ContentType) stack.push([ca.type, (cb as Y.ContentType).type, root, `${root}/${id(ia.id)}`]);
  }
  return null;
}

/**
 * Per-client struct boundaries, then the structs and deletes waiting for a missing dependency. Items are compared struct
 * by struct; a run of GC structs as one range: Yjs merges GC runs on a reload only, and never splits one to integrate.
 */
function storeDiff(a: Y.Doc['store'], b: Y.Doc['store']): OrderDiff | null {
  for (const [client, sa] of a.clients) {
    const sb = b.clients.get(client) ?? [];
    let i = 0;
    let j = 0;
    while (i < sa.length || j < sb.length) {
      const x = unit(sa, i);
      const y = unit(sb, j);
      if (!x || !y || x.clock !== y.clock || x.length !== y.length || x.kind !== y.kind) {
        const s = (u: typeof x) => (u ? `${u.clock}+${u.length}${u.kind}` : '-');
        return { path: `store/${client}`, kind: 'store', detail: `[${i}] a=${s(x)} b=${s(y)}` };
      }
      i = x.next;
      j = y.next;
    }
  }
  for (const [client, sb] of b.clients) {
    if (!a.clients.has(client) && sb.length) return { path: `store/${client}`, kind: 'store', detail: `a=- b=${sb.length}` };
  }
  const pa = a.pendingStructs;
  const pb = b.pendingStructs;
  if (!pa !== !pb || (pa && pb && (!sameBytes(pa.update, pb.update) || !sameMap(pa.missing, pb.missing)))) {
    return { path: 'store', kind: 'pending', detail: `structs a=${!!pa} b=${!!pb}` };
  }
  if (!sameBytes(a.pendingDs, b.pendingDs)) return { path: 'store', kind: 'pending', detail: `ds a=${!!a.pendingDs} b=${!!b.pendingDs}` };
  return null;
}

/** The struct at `i`, or the GC run starting there; `next` is the index after it. */
function unit(structs: Array<Y.GC | Y.Item>, i: number): { clock: number; length: number; kind: string; next: number } | null {
  const s = structs[i];
  if (!s) return null;
  if (!(s instanceof Y.GC)) return { clock: s.id.clock, length: s.length, kind: s instanceof Y.Item ? 'item' : 'skip', next: i + 1 };
  let length = 0;
  let next = i;
  for (; structs[next] instanceof Y.GC; next++) length += structs[next].length;
  return { clock: s.id.clock, length, kind: 'gc', next };
}

function sameBytes(x: Uint8Array | null, y: Uint8Array | null): boolean {
  if (!x || !y) return x === y;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function sameMap(x: Map<number, number>, y: Map<number, number>): boolean {
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
}

/**
 * The items of `live` whose order differs in `reload`: for every list chain and key chain present in both, the ids
 * outside a heaviest common subsequence of the two orders (by clocks, O(n log n)). Both chains are cut at the union of
 * their struct boundaries, so the work is bounded by structs, never by the clocks one struct claims (a 16-byte crafted
 * tombstone claims millions). A displaced run of one author's clocks is reported once, at its first clock. At most
 * `limit` entries.
 */
export function displacedItems(live: Y.Doc, reload: Y.Doc, limit = 64): Array<{ client: number; clock: number }> {
  const out: Array<{ client: number; clock: number }> = [];
  const stack: Array<[Type, Type]> = [];
  for (const [name, t] of live.share) {
    const u = reload.share.get(name);
    if (u) stack.push([t, u]);
  }
  while (stack.length && out.length < limit) {
    const [t, u] = stack.pop()!;
    displacedIn(t._start, u._start, out, limit);
    for (const [key, item] of t._map) {
      const other = u._map.get(key);
      if (other) displacedIn(leftmost(item), leftmost(other), out, limit);
    }
    const push = (item: Y.Item | null) => {
      if (item && !item.deleted && item.content instanceof Y.ContentType) {
        const twin = counterpart(reload, item.id);
        if (twin) stack.push([item.content.type, twin]);
      }
    };
    for (let i = t._start; i; i = i.right) push(i);
    for (const item of t._map.values()) push(item);
  }
  return out;
}

function counterpart(doc: Y.Doc, at: Y.ID): Type | null {
  if (Y.getState(doc.store, at.client) <= at.clock) return null;
  const s = Y.getItem(doc.store, at);
  return s instanceof Y.Item && s.content instanceof Y.ContentType ? s.content.type : null;
}

function displacedIn(a: Y.Item | null, b: Y.Item | null, out: Array<{ client: number; clock: number }>, limit: number) {
  if (!a || !b) return;
  const cuts = new Map<number, number[]>();
  for (const head of [a, b]) {
    for (let i: Y.Item | null = head; i; i = i.right) {
      let c = cuts.get(i.id.client);
      if (!c) cuts.set(i.id.client, (c = []));
      c.push(i.id.clock, i.id.clock + i.length);
    }
  }
  for (const c of cuts.values()) c.sort((x, y) => x - y);
  const units = sequence(a, cuts);
  const index = indexOf(sequence(b, cuts));
  // Heaviest increasing subsequence of each unit's position in `b` (a Fenwick tree of prefix maxima): the units on it
  // are in the same relative order in both, and hold the most clocks.
  const n = units.length;
  const tree = new Float64Array(index.size + 1);
  const from = new Int32Array(index.size + 1).fill(-1);
  const best = new Float64Array(n);
  const prev = new Int32Array(n).fill(-1);
  let top = -1;
  for (let i = 0; i < n; i++) {
    const p = index.get(key(units[i]));
    if (p === undefined) continue;
    let v = 0;
    for (let k = p; k > 0; k -= k & -k) {
      if (tree[k] > v) [v, prev[i]] = [tree[k], from[k]];
    }
    best[i] = v + units[i][2];
    for (let k = p + 1; k <= index.size; k += k & -k) {
      if (tree[k] < best[i]) [tree[k], from[k]] = [best[i], i];
    }
    if (top < 0 || best[i] > best[top]) top = i;
  }
  const kept = new Uint8Array(n);
  for (let i = top; i >= 0; i = prev[i]) kept[i] = 1;
  let last: [number, number] | null = null;
  for (let i = 0; i < n && out.length < limit; i++) {
    if (kept[i]) {
      last = null;
      continue;
    }
    const [client, clock, len] = units[i];
    if (!last || last[0] !== client || last[1] !== clock) out.push({ client, clock });
    last = [client, clock + len];
  }
}

/** A chain as [client, clock, length] units, each struct cut at every boundary in `cuts` (which holds its own). */
function sequence(item: Y.Item | null, cuts: Map<number, number[]>): Array<[number, number, number]> {
  const units: Array<[number, number, number]> = [];
  for (; item; item = item.right) {
    const { client, clock } = item.id;
    const c = cuts.get(client)!;
    const end = clock + item.length;
    let k = 0;
    for (let hi = c.length; k < hi; ) {
      const mid = (k + hi) >> 1;
      if (c[mid] <= clock) k = mid + 1;
      else hi = mid;
    }
    for (let at = clock; at < end; k++) {
      const to = Math.min(c[k], end);
      if (to > at) units.push([client, at, to - at]);
      at = to;
    }
  }
  return units;
}

const key = (u: [number, number, number]) => `${u[0]}:${u[1]}`;

function indexOf(units: Array<[number, number, number]>): Map<string, number> {
  return new Map(units.map((u, i) => [key(u), i]));
}

/** `doc` against a reload of itself (the order a joiner, a restart or a compaction would see). */
export function isReloadStable(doc: Y.Doc): { stable: boolean; diff: OrderDiff | null; reload: Y.Doc } {
  const reload = new Y.Doc({ gc: doc.gc, gcFilter: doc.gcFilter });
  Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
  const diff = strictOrderDiff(doc, reload);
  return { stable: diff === null, diff, reload };
}
