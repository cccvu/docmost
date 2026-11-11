import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as vm from 'node:vm';
import * as Y from 'yjs';
import {
  ConflictScan,
  ConflictScanMeterError,
  installConflictScanMeter,
} from './conflict-scan';
import { copyOf, rawUpdate, siblingsShape, twoClientsShape, unguardedSteps, type RawClient, type RawDeletes } from './conflict-scan.testkit';

/**
 * #816 (ADR 0036): the conflict-scan meter replays Yjs's integrate walks before Yjs makes them and refuses a frame past
 * its caps. These specs pin what makes it safe to depend on: the replay counts exactly what Yjs walks (against an
 * instrumented copy of yjs's own loop), the source it replays is the source installed (a tripwire on any yjs bump), it is
 * inert outside its scope, it installs once, it refuses to install on a yjs it was not written for, and it fails closed.
 */

/** Pinned: yjs's `Item.prototype.integrate` source and version the replay in conflict-scan.ts was written against. */
const PINNED_YJS_VERSION = '13.6.30';
const PINNED_INTEGRATE_SHA256 = 'e1840302775981b0ed0c7b62f05695c53dc03dc3ab196fd70c44865a9638d267';
const RE_VALIDATE = [
  'yjs changed under the conflict-scan meter (#816, ADR 0036). Before updating the pins:',
  '1. diff the new Item.prototype.integrate (src/structs/Item.js) against 13.6.30 Item.js:415-496;',
  '2. mirror every change to its walks (the offset > 0 left, the entry condition, the keyed pre-walk, the loop, the',
  '   keyed reconnect walk) and to the reads it makes in conflict-scan.ts `replay`, read for read;',
  '3. re-check the exports it uses (compareIDs, getItem, createID) and the instrumentation anchors in this spec;',
  '4. run this spec (the exactness corpus must stay at zero mismatches) and the honest-concurrency spec;',
  '5. then update PINNED_YJS_VERSION and PINNED_INTEGRATE_SHA256.',
].join('\n');

/**
 * A scratch copy of the installed yjs CJS dist with counters in its three integrate walks and its case-2 branch, loaded
 * from source in a vm (never written to disk). The reference the replay is checked against.
 */
function instrumentedYjs(): { IY: typeof Y; counts: { pre: number; loop: number; rec: number; case2: number } } {
  const file = require.resolve('yjs');
  let src = readFileSync(file, 'utf8');
  const anchors: Array<[string, string]> = [
    ['while (o !== null && o.left !== null) {', 'while (o !== null && o.left !== null) { __count.pre++;'],
    ['while (o !== null && o !== this.right) {', 'while (o !== null && o !== this.right) { __count.loop++;'],
    ['while (r !== null && r.left !== null) {', 'while (r !== null && r.left !== null) { __count.rec++;'],
    ['if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {', '__count.case2++; if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {'],
  ];
  for (const [anchor, replacement] of anchors) {
    expect(src.split(anchor).length - 1).toBe(1); // one match each, or the instrumentation is not what it claims
    src = src.replace(anchor, replacement);
  }
  const counts = { pre: 0, loop: 0, rec: 0, case2: 0 };
  const fn = vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname', '__count'], { filename: `${file}.instrumented` });
  const outer = vm.runInThisContext('globalThis') as Record<string, unknown>;
  const flag = '__ $YJS$ __';
  const had = outer[flag];
  delete outer[flag]; // silence yjs's double-import warning
  const module = { exports: {} as typeof Y };
  fn(module.exports, createRequire(file), module, file, dirname(file), counts);
  outer[flag] = had;
  return { IY: module.exports, counts };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('#816 the replay counts exactly what Yjs walks', () => {
  it('per item, over a seeded corpus of honest concurrency and random hostile updates, against an instrumented yjs', () => {
    const { IY, counts } = instrumentedYjs();
    const meter = installConflictScanMeter(IY);
    const proto = IY.Item.prototype as any;
    const metered = proto.integrate;
    const tally = { checked: 0, nonzero: 0, maxSeen: 0, mismatches: [] as unknown[], offsets: 0, meterThrew: 0, yjsAgreed: 0, steps: 0 };
    let scan: ConflictScan | null = null;
    proto.integrate = function (tr: Y.Transaction, offset: number) {
      if (offset > 0) tally.offsets++;
      const before = counts.pre + counts.loop + counts.rec;
      const items = scan?.items ?? 0;
      try {
        metered.call(this, tr, offset);
      } catch (err) {
        if (err instanceof ConflictScanMeterError) {
          // The replay threw: Yjs's own walk must throw at the same point (the replay reads only what Yjs reads).
          tally.meterThrew++;
          let threw = false;
          try {
            meter.original.call(this, tr, offset);
          } catch {
            threw = true;
          }
          if (threw) tally.yjsAgreed++;
          else tally.mismatches.push({ id: this.id, offset, replayThrew: true });
        }
        throw err;
      }
      if (scan && scan.items > items) {
        const truth = counts.pre + counts.loop + counts.rec - before;
        tally.checked++;
        tally.steps += truth;
        if (truth) tally.nonzero++;
        tally.maxSeen = Math.max(tally.maxSeen, truth);
        if (truth !== scan.lastItem && tally.mismatches.length < 5) tally.mismatches.push({ truth, replay: scan.lastItem, id: this.id, offset });
      }
    };
    const apply = (doc: Y.Doc, update: Uint8Array) => {
      scan = new ConflictScan(doc, false, Infinity);
      try {
        meter.metered(scan, () => IY.applyUpdate(doc, update));
      } catch {
        // a hostile update Yjs cannot integrate: that item is not compared
      } finally {
        scan = null;
      }
    };

    const honest = (seed: number) => {
      const r = rng(seed);
      const n = 2 + Math.floor(r() * 4);
      const peers = Array.from({ length: n }, () => {
        const d = new IY.Doc();
        d.clientID = 1000 + Math.floor(r() * 1e6);
        return d;
      });
      const server = new IY.Doc();
      const queues: Uint8Array[][] = peers.map(() => []);
      peers.forEach((p, i) => p.on('update', (u: Uint8Array) => queues[i].push(u)));
      for (let step = 0; step < 300; step++) {
        const p = peers[Math.floor(r() * n)];
        const t = p.getText('t');
        const op = r();
        if (op < 0.45) t.insert(Math.floor(r() * (t.length + 1)), 'abcdef'.slice(0, 1 + Math.floor(r() * 5)), r() < 0.3 ? { bold: true } : undefined);
        else if (op < 0.65 && t.length) {
          const at = Math.floor(r() * t.length);
          t.delete(at, Math.min(t.length - at, 1 + Math.floor(r() * 4)));
        } else if (op < 0.75 && t.length) {
          const at = Math.floor(r() * t.length);
          t.format(at, Math.min(t.length - at, 3), { italic: r() < 0.5 ? true : null });
        } else if (op < 0.9) p.getMap('m').set('k' + Math.floor(r() * 3), Math.floor(r() * 100));
        if (r() < 0.3) {
          const j = Math.floor(r() * n);
          if (queues[j].length) {
            apply(server, IY.mergeUpdates(queues[j].splice(0))); // an offline run, merged
            for (let k = 0; k < n; k++) if (k !== j && r() < 0.7) apply(peers[k], IY.encodeStateAsUpdate(server, IY.encodeStateVector(peers[k])));
          }
        }
      }
      for (let j = 0; j < n; j++) if (queues[j].length) apply(server, IY.mergeUpdates(queues[j].splice(0)));
      for (const p of peers) apply(new IY.Doc(), IY.encodeStateAsUpdate(p)); // reloads
      apply(new IY.Doc(), IY.encodeStateAsUpdate(server));
    };

    const hostile = (seed: number) => {
      const r = rng(seed);
      const doc = new IY.Doc();
      doc.clientID = 1;
      doc.getText('t').insert(0, 'seed text here');
      doc.getMap('m').set('a', 1);
      const pool = [2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
      const pickId = (kind: 't' | 'm'): [number, number] | null => {
        const parent = kind === 'm' ? doc.getMap('m') : doc.getText('t');
        const ids: Array<[number, number]> = [];
        for (const [client, structs] of doc.store.clients) {
          for (const s of structs) if (s instanceof IY.Item && s.parent === parent) ids.push([client, s.id.clock + Math.floor(r() * s.length)]);
        }
        return ids.length ? ids[Math.floor(r() * ids.length)] : null;
      };
      for (let u = 0; u < 100; u++) {
        const clients: RawClient[] = [];
        const used = new Set<number>();
        for (let c = 1 + Math.floor(r() * 3); c > 0; c--) {
          const client = pool[Math.floor(r() * pool.length)];
          if (used.has(client)) continue;
          used.add(client);
          let clock = IY.getState(doc.store, client);
          if (clock > 0 && r() < 0.15) clock -= 1; // an overlap: integrate with offset > 0
          const structs = [];
          for (let s = 1 + Math.floor(r() * 5); s > 0; s--) {
            if (r() < 0.25) {
              structs.push({ origin: r() < 0.8 ? pickId('m') : null, right: r() < 0.3 ? pickId('m') : null, parent: 'm', sub: 'k' + Math.floor(r() * 2), content: new IY.ContentAny([s]) });
            } else {
              structs.push({ origin: r() < 0.85 ? pickId('t') : null, right: r() < 0.7 ? pickId('t') : null, parent: 't', content: new IY.ContentString('xy'.slice(0, 1 + Math.floor(r() * 2))) });
            }
          }
          clients.push({ client, clock, structs });
        }
        const ds: RawDeletes = [];
        const del = r() < 0.3 ? pickId('t') : null;
        if (del) ds.push({ client: del[0], ranges: [[del[1], 1 + Math.floor(r() * 3)]] });
        let update: Uint8Array;
        try {
          update = rawUpdate(clients, ds, IY);
        } catch {
          continue;
        }
        apply(doc, update);
        if (u % 40 === 39) apply(new IY.Doc(), IY.encodeStateAsUpdate(doc));
      }
    };

    for (let seed = 1; seed <= 60; seed++) {
      honest(seed);
      hostile(seed * 7919);
    }
    // The crafted shapes too (small), so long walks and both caps' paths are in the corpus.
    for (const shape of [siblingsShape(300, 40), twoClientsShape(200)]) {
      const base = new IY.Doc();
      IY.applyUpdate(base, Y.encodeStateAsUpdate(shape.base)); // built on the real yjs, replayed on the instrumented one
      apply(base, shape.frame);
    }
    proto.integrate = metered;
    if (process.env.CONFLICT_SCAN_TALLY) console.log(JSON.stringify({ ...tally, counts }));
    expect(tally.mismatches).toEqual([]);
    // Anti-vacuity: every walk and branch the replay mirrors was exercised, with long walks among them.
    expect(tally.checked).toBeGreaterThan(20_000);
    expect(tally.nonzero).toBeGreaterThan(1_000);
    expect(tally.maxSeen).toBeGreaterThan(300);
    for (const c of Object.values(counts)) expect(c).toBeGreaterThan(0);
    expect(tally.offsets).toBeGreaterThan(0);
    expect(tally.yjsAgreed).toBe(tally.meterThrew);
  });
});

describe('#816 tripwire: the yjs source the replay was written against', () => {
  it('Item.prototype.integrate and the yjs version equal the pinned ones', () => {
    const meter = installConflictScanMeter(Y);
    const version = (JSON.parse(readFileSync(require.resolve('yjs/package.json'), 'utf8')) as { version: string }).version;
    const sha = createHash('sha256').update(meter.original.toString()).digest('hex');
    if (version !== PINNED_YJS_VERSION || sha !== PINNED_INTEGRATE_SHA256) {
      throw new Error(`${RE_VALIDATE}\n(installed yjs ${version}, integrate sha256 ${sha})`);
    }
    expect(meter.original).not.toBe(Y.Item.prototype.integrate); // the hash is of yjs's own, not the wrapper's
  });
});

describe('#816 the meter is inert outside its scope, installs once, and refuses a yjs it was not written for', () => {
  const meter = installConflictScanMeter(Y);

  it('a tripped scope throws inside, and afterwards (and for any other document) the wrapper never throws or counts', () => {
    const { base, frame } = twoClientsShape(50);
    const victim = copyOf(base);
    const scan = new ConflictScan(victim, true, 100);
    expect(() => meter.metered(scan, () => Y.applyUpdate(victim, frame))).toThrow();
    expect(scan.trip).toEqual({ steps: 101 });
    expect(meter.isActive()).toBe(false);
    // the same expensive frame, outside any scope: on another copy, and on the very document the scope tripped on
    const other = copyOf(base);
    expect(() => Y.applyUpdate(other, frame)).not.toThrow();
    expect(() => Y.applyUpdate(victim, frame)).not.toThrow();
    // inside a scope for ANOTHER document, nothing is metered
    const third = copyOf(base);
    const elsewhere = new ConflictScan(new Y.Doc(), true, 0);
    expect(() => meter.metered(elsewhere, () => Y.applyUpdate(third, frame))).not.toThrow();
    expect(elsewhere).toMatchObject({ steps: 0, items: 0, trip: null });
  });

  it('the scope is cleared after a throw that is not the meter\'s', () => {
    expect(() =>
      meter.metered(new ConflictScan(new Y.Doc(), true), () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(meter.isActive()).toBe(false);
  });

  it('the frame cap: the trip is recorded on the scope; report mode counts past it and never throws', () => {
    const { base, frame } = twoClientsShape(300);
    const total = unguardedSteps(base, frame);
    expect(total).toBe(300 * 300 + 299); // n·m, plus one break step per item after the first
    const perFrame = copyOf(base);
    const byFrame = new ConflictScan(perFrame, true, 1000);
    expect(() => meter.metered(byFrame, () => Y.applyUpdate(perFrame, frame))).toThrow();
    expect(byFrame.trip).toEqual({ steps: 1001 });
    const reported = copyOf(base);
    const report = new ConflictScan(reported, false, 1000);
    expect(() => meter.metered(report, () => Y.applyUpdate(reported, frame))).not.toThrow();
    expect(report.trip).toEqual({ steps: 1001 });
    expect(report.steps).toBe(total);
    expect(Y.encodeStateAsUpdate(reported)).toEqual(Y.encodeStateAsUpdate(unguardedDoc(base, frame)));
  });

  it('installs once: a second install returns the same meter and wraps nothing twice', () => {
    const wrapper = Y.Item.prototype.integrate;
    expect(installConflictScanMeter(Y)).toBe(meter);
    expect(Y.Item.prototype.integrate).toBe(wrapper);
    expect(meter.original).not.toBe(wrapper);
    expect(meter.original.toString()).toContain('conflictingItems'); // yjs's own, not a wrapper of a wrapper
  });

  it('refuses to install when integrate, compareIDs, getItem or createID is missing or changed shape', () => {
    const fake = (patch: Record<string, unknown> = {}) => {
      class Item {
        integrate(_transaction: unknown, _offset: unknown) {}
      }
      return { Item, compareIDs: (_a: unknown, _b: unknown) => true, getItem: (_s: unknown, _i: unknown) => null, createID: (_c: unknown, _k: unknown) => null, ...patch } as unknown as typeof Y;
    };
    expect(() => installConflictScanMeter(fake())).not.toThrow(); // the shapes the replay was written against
    expect(() => installConflictScanMeter(fake({ Item: undefined }))).toThrow(/Item.prototype.integrate.*refusing to start/);
    expect(() => installConflictScanMeter(fake({ Item: class { integrate(_t: unknown) {} } }))).toThrow(/Item.prototype.integrate/);
    expect(() => installConflictScanMeter(fake({ Item: class {} }))).toThrow(/Item.prototype.integrate/);
    expect(() => installConflictScanMeter(fake({ getItem: undefined }))).toThrow(/getItem/);
    expect(() => installConflictScanMeter(fake({ compareIDs: (_a: unknown) => true }))).toThrow(/compareIDs/);
    expect(() => installConflictScanMeter(fake({ createID: 'createID' }))).toThrow(/createID/);
  });

  it('so the guard (and with it the server boot) refuses to construct on such a yjs', () => {
    const flag = '__ $YJS$ __';
    const had = (globalThis as Record<string, unknown>)[flag];
    delete (globalThis as Record<string, unknown>)[flag]; // a second yjs instance on purpose: silence its warning
    jest.isolateModules(() => {
      jest.doMock('yjs', () => {
        const actual = jest.requireActual('yjs');
        class Item {
          integrate(_transaction: unknown) {} // one argument: not the integrate the replay mirrors
        }
        return { ...actual, Item };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CollabUpdateGuard } = require('./update-guard') as typeof import('./update-guard');
      expect(() => new CollabUpdateGuard({ logger: { warn: () => undefined } })).toThrow(/conflict-scan meter.*refusing to start/);
    });
    jest.dontMock('yjs');
    (globalThis as Record<string, unknown>)[flag] = had;
  });
});

describe('#816 the meter fails closed', () => {
  const meter = installConflictScanMeter(Y);

  it('an error inside the replay is a ConflictScanMeterError recorded on the scope, never a trip, never applied unmetered', () => {
    const { base, frame } = twoClientsShape(5);
    const doc = copyOf(base);
    const boom = new Error('injected');
    const spy = jest.spyOn(Y, 'compareIDs').mockImplementation(() => {
      throw boom;
    });
    const scan = new ConflictScan(doc, true);
    let thrown: unknown;
    try {
      meter.metered(scan, () => Y.applyUpdate(doc, frame));
    } catch (err) {
      thrown = err;
    } finally {
      spy.mockRestore();
    }
    expect(thrown).toBeInstanceOf(ConflictScanMeterError);
    expect((thrown as ConflictScanMeterError).failure).toBe(boom);
    expect(scan.failure).toBe(boom);
    expect(scan.trip).toBeNull();
    expect(scan.items).toBe(0);
    // report mode fails closed too: a meter that cannot count does not let the frame through as if it had
    const reported = copyOf(base);
    const spy2 = jest.spyOn(Y, 'compareIDs').mockImplementation(() => {
      throw boom;
    });
    try {
      expect(() => meter.metered(new ConflictScan(reported, false), () => Y.applyUpdate(reported, frame))).toThrow(ConflictScanMeterError);
    } finally {
      spy2.mockRestore();
    }
    // and outside the scope the same frame applies
    expect(() => Y.applyUpdate(copyOf(base), frame)).not.toThrow();
  });
});

function unguardedDoc(base: Y.Doc, frame: Uint8Array): Y.Doc {
  const doc = copyOf(base);
  Y.applyUpdate(doc, frame);
  return doc;
}
