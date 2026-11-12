import * as Y from 'yjs';
import { liveWedged } from '../page-write/compaction-registry';

/**
 * #847 G4 (ADR 0036): what a WEDGED live document still holds. Yjs 13.6.30's cleanup throws on a parent delete over a
 * stranded keyed piece (M2), and from then on every transaction integrates but is never cleaned up: no update event,
 * so no broadcast and no store. The guard freezes such a page and heals it by compaction FROM LIVE (`liveWedged`,
 * compaction-registry.ts), which is sound only if a wedged document's visible tree is still the right one, and its
 * encoding reloads into the same tree. This seeded fuzz checks both: an XmlFragment page with attributes, crafted
 * multi-value keyed items, delete-set-only splits of them and parent deletes, fed to live (gc on, the server's) and to
 * an oracle with gc off (which never wedges) as the same stream. At every step the two visible trees (attribute keys
 * sorted) are equal, before and after the wedge, and at the end of each run a reload of live's encoding equals live.
 * Anti-vacuity: most runs wedge, and many updates land after a wedge.
 */
const RUNS = 300;
const STEPS = 40;
const SEED = 847_000;

type Canon = { t: string; a: Record<string, unknown>; c: Canon[] } | Canon[] | string;
const canon = (n: unknown): Canon =>
  n instanceof Y.XmlElement
    ? { t: n.nodeName, a: Object.fromEntries(Object.entries(n.getAttributes()).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))), c: n.toArray().map(canon) }
    : n instanceof Y.XmlFragment
      ? n.toArray().map(canon)
      : String(n);
const visible = (d: Y.Doc) => JSON.stringify(canon(d.getXmlFragment('default')));
const elements = (f: Y.XmlFragment | Y.XmlElement): Array<Y.XmlFragment | Y.XmlElement> => {
  const out: Array<Y.XmlFragment | Y.XmlElement> = [f];
  for (const c of f.toArray()) if (c instanceof Y.XmlElement) out.push(...elements(c));
  return out;
};
const varUint = (n: number): number[] => {
  const b: number[] = [];
  while (n > 127) {
    b.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  b.push(n);
  return b;
};

function fuzz(seed: number) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  let nextClient = 100;
  const stats = { runs: 0, wedgedRuns: 0, visibleMismatches: 0, reloadMismatches: 0, liveThrows: 0, postWedgeUpdates: 0, unwedged: 0 };
  for (let run = 0; run < RUNS; run++) {
    stats.runs++;
    const live = new Y.Doc();
    const oracle = new Y.Doc({ gc: false });
    let wedgedAt = -1;
    const apply = (u: Uint8Array) => {
      Y.applyUpdate(oracle, u);
      try {
        Y.applyUpdate(live, u);
      } catch {
        stats.liveThrows++;
      }
    };
    for (let step = 0; step < STEPS; step++) {
      // a peer at the oracle's state (an honest replica with every value: gc off)
      const a = new Y.Doc({ gc: false });
      a.clientID = nextClient++;
      Y.applyUpdate(a, Y.encodeStateAsUpdate(oracle));
      const ups: Uint8Array[] = [];
      a.on('update', (u: Uint8Array) => ups.push(u));
      const f = a.getXmlFragment('default');
      const es = elements(f);
      const host = pick(es);
      const r = rnd();
      if (r < 0.3 || host.length === 0) {
        const e = new Y.XmlElement('p');
        host.insert(Math.floor(rnd() * (host.length + 1)), [e]);
        e.setAttribute('a', String(step));
        e.insert(0, [new Y.XmlText('t' + step)]);
      } else if (r < 0.45) {
        const cand = es.filter((e): e is Y.XmlElement => e !== f);
        if (cand.length) pick(cand).setAttribute(pick(['a', 'b']), String(step));
      } else if (r < 0.6) {
        // a crafted keyed item holding three values (what a pre-#847 frame could store)
        const cand = es.filter((e): e is Y.XmlElement => e !== f);
        if (cand.length) {
          const e = pick(cand);
          const sv = Y.encodeStateVector(a);
          e.setAttribute('k', 'x');
          const it = e._map.get('k')!;
          (it.content as Y.ContentAny).arr.push('y', 'z');
          it.length = 3;
          ups.length = 0;
          ups.push(Y.encodeStateAsUpdate(a, sv));
        }
      } else if (r < 0.75) {
        // a delete-set-only frame splitting a live multi-value keyed item
        const longs: Y.Item[] = [];
        for (const structs of oracle.store.clients.values()) for (const x of structs) if (x instanceof Y.Item && x.parentSub && !x.deleted && x.length > 1) longs.push(x);
        if (longs.length) {
          const x = pick(longs);
          const off = 1 + Math.floor(rnd() * (x.length - 1));
          ups.push(new Uint8Array([0, 1, ...varUint(x.id.client), 1, ...varUint(x.id.clock + off), 1]));
        }
      } else if (r < 0.88) {
        // a parent delete of an element holding a split or multi-value keyed item
        const hold = elements(f).filter(
          (e): e is Y.XmlElement =>
            e !== f &&
            [...(e as Y.XmlElement)._map.values()].some((it) => {
              for (let x: Y.Item | null = it; x; x = x.left) if ((!x.deleted && x !== it) || x.length > 1) return true;
              return false;
            }),
        );
        if (hold.length) {
          const e = pick(hold);
          const p = e.parent as Y.XmlElement | Y.XmlFragment;
          const idx = p.toArray().indexOf(e);
          if (idx >= 0) p.delete(idx, 1);
        }
      } else if (host.length) {
        host.delete(Math.floor(rnd() * host.length), 1);
      }
      for (const u of ups) {
        if (wedgedAt >= 0) stats.postWedgeUpdates++;
        apply(u);
      }
      if (wedgedAt < 0 && liveWedged(live)) {
        wedgedAt = step;
        stats.wedgedRuns++;
      } else if (wedgedAt >= 0 && !liveWedged(live)) {
        stats.unwedged++;
      }
      if (visible(live) !== visible(oracle)) stats.visibleMismatches++;
    }
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(live));
    if (visible(reload) !== visible(live)) stats.reloadMismatches++;
  }
  return stats;
}

describe('#847 a wedged live document: its visible tree and its reload stay right (seeded fuzz)', () => {
  it(`${RUNS} runs of ${STEPS} steps: live equals the gc-off oracle at every step, and its reload equals it`, () => {
    const stats = fuzz(SEED);
    console.log(`#847 wedge integrity: ${JSON.stringify(stats)}`);
    expect(stats.visibleMismatches).toBe(0);
    expect(stats.reloadMismatches).toBe(0);
    expect(stats.unwedged).toBe(0); // a wedge is for good: never unwedged by later transactions
    // anti-vacuity: the fuzz really wedges live, and really feeds it afterwards
    expect(stats.wedgedRuns).toBeGreaterThan(RUNS / 4);
    expect(stats.liveThrows).toBeGreaterThanOrEqual(stats.wedgedRuns);
    expect(stats.postWedgeUpdates).toBeGreaterThan(RUNS * 5);
  });
});
