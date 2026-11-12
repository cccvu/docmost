import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as vm from 'node:vm';
import * as Y from 'yjs';
import { COLLAB_PAGE_COMPACTING_REASON, pageCompactingRefusal } from './collab-reasons';
import {
  ConflictScan,
  ConflictScanArmError,
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

/**
 * Pinned: yjs's `Item.prototype.integrate` source and version the replay in conflict-scan.ts was written against: stock
 * 13.6.30 with the fork's patch C (`[ccc #847]`, patches/yjs@13.6.30.patch: the offset branch's origin and its GC rule;
 * stock was e1840302…, re-pinned by yjs-redo-patch.spec.ts).
 */
const PINNED_YJS_VERSION = '13.6.30';
const PINNED_INTEGRATE_SHA256 = '031193b8ffb9b780e46ac1b5d308276e05bd33b15ffd67e69216bb25a632471e';
const RE_VALIDATE = [
  'yjs changed under the conflict-scan meter (#816, ADR 0036). Before updating the pins:',
  '1. diff the new Item.prototype.integrate (src/structs/Item.js) against 13.6.30 Item.js:415-496 as patch C',
  '   ([ccc #847], patches/yjs@13.6.30.patch) changes it;',
  '2. mirror every change to its walks (the offset > 0 left and its GC rule, the entry condition, the keyed pre-walk, the',
  '   loop, the keyed reconnect walk) and to the reads it makes in conflict-scan.ts `replay`, read for read;',
  '3. re-check the exports it uses (compareIDs, getItem, createID, GC) and the instrumentation anchors in this spec;',
  '4. run this spec (the exactness corpus must stay at zero mismatches) and the honest-concurrency spec;',
  '5. then update PINNED_YJS_VERSION and PINNED_INTEGRATE_SHA256.',
].join('\n');

/**
 * #827: the other yjs internals the #827 bounds were measured and reasoned against (doc-bounds.ts), by their source in
 * the installed dist (most are not exported). A change to any of them can move a cost the bounds assume or open a path
 * they do not see.
 */
const PINNED_827_SOURCES: Record<string, string> = {
  integrateStructs: '78ba1f407bdd9d8810b60cd5dc7bc4fa7ac85bad9b19936f7761a545c85d232e', // the load path: client order, the getMissing stack
  readUpdateV2: 'a10c2240bedd551917fd5ca9a071eb518e252558f4cfa1020615eed070ce597c', // every apply and load: one remote transaction
  readAndApplyDeleteSet: 'fd69b9ebfae74fb9cbafa7228235ec2cb1cf9a2d5ce88e279248d28efcf2e3cd', // delete-range splits (#827 b)
  tryMergeDeleteSet: 'b8b867ff5008036474cbefb6b11ff1bdbb76bac86057f6c034a1a0c5f5ba7083', // the select-all splices (E_MAX)
  tryToMergeWithLefts: 'da459f72626dfe2b27a39f83bca232431f39a1b23ea5358f6aeda4764b563901',
  transact: '5c41b75d2586c5ac85b4b2b97719af256c8b244119c3d83a6d4c0061bd590be3', // its finally: what a deadline's cut skips
  cleanupTransactions: '84c3e7ed166035e93dc5b80cb51d49ce8b27819da7414f22e508f269e318a7f6', // O(client ids) per transaction (C_MAX)
  cleanupYTextAfterTransaction: '6e3ee79c4653cbd881675c84e8827d24f21b737f3603a259e4d9a9e48aff450c', // formatting cleanup (#827 a)
  cleanupContextlessFormattingGap: 'ebbe974183cf6c422ffeda7fd775ad30edb058b734add3b8f615329abe307afd',
  cleanupFormattingGap: '92e8c93f8c892cc79d96b95cc26f99da4006483442efb3483d7136bd51874481',
  // #847: every split pushes its right half to transaction._mergeStructs; the guard's keyed-split product rule reads it.
  splitItem: '8e2510f30e4d2bf0e1bdfd28ba47651799e818d1f2e0410c68c2a9617fc58b75',
};
const RE_VALIDATE_827 = [
  'yjs changed under the #827 bounds (ADR 0036, doc-bounds.ts). Before updating PINNED_827_SOURCES:',
  '1. diff each changed function against yjs 13.6.30 (src/utils/encoding.js integrateStructs/readUpdateV2,',
  '   DeleteSet.js readAndApplyDeleteSet, Transaction.js transact/cleanupTransactions/tryMergeDeleteSet/',
  '   tryToMergeWithLefts, YText.js cleanupYTextAfterTransaction and the formatting-gap helpers, Item.js splitItem);',
  '   a change to splitItem: re-check that every split still pushes its right half to transaction._mergeStructs',
  '   (#847: the keyed-split rule finds split products there);',
  '2. a change to the load order or to the getMissing stack: re-check that the meter, armed on a loading doc, still',
  '   counts a load exactly (the arm specs below) and that W_MAX still bounds the inversion (#827 c);',
  '3. a change to transact/cleanupTransactions: re-run deadline.spec.ts (an interrupted doc stays mid-transaction and',
  '   is discarded; nothing outside it is touched) and the load-throw spec below (an ordinary throw leaves Yjs clean);',
  '4. any change: re-run the sizing bench (yjs-bounds.sizing.bench.cjs) on node:22-slim and update doc-bounds.ts and',
  '   doc-bounds.spec.ts (S_MAX, C_MAX, E_MAX, W_MAX, T_FRAME_MS keep their margins);',
  '5. then update the pins.',
].join('\n');

/** The source of the top-level `const <name> = …` in the installed yjs dist, up to the next top-level statement. */
function yjsSource(name: string): string {
  const src = readFileSync(require.resolve('yjs'), 'utf8');
  const decl = `\nconst ${name} = `;
  const at = src.indexOf(decl);
  if (at < 0 || src.indexOf(decl, at + 1) >= 0) return `<${name}: ${at < 0 ? 'missing' : 'declared twice'}>`;
  const rest = src.slice(at + 1);
  const end = rest.search(/\n(?=(?:\/\*\*|const |let |class |function |exports\.))/);
  return (end < 0 ? rest : rest.slice(0, end)).trimEnd();
}

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
    const tally = { checked: 0, nonzero: 0, maxSeen: 0, mismatches: [] as unknown[], offsets: 0, gcOffsets: 0, meterThrew: 0, yjsAgreed: 0, steps: 0 };
    let scan: ConflictScan | null = null;
    proto.integrate = function (tr: Y.Transaction, offset: number) {
      if (offset > 0) {
        tally.offsets++;
        // #847: the tail of a partly known struct whose previous clock is a GC here (patch C integrates it as a GC)
        if (IY.getItem(tr.doc.store, IY.createID(this.id.client, this.id.clock + offset - 1)) instanceof IY.GC) tally.gcOffsets++;
      }
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

    /**
     * #847: GC'd blocks. Nested texts in a root array take frames from several clients, and some texts are deleted, so
     * their children become GC structs; frames that overlap a client's last clock (offset > 0) then land on a GC (patch
     * C: the tail integrates as a GC) or on a live Item (in its own list or another one).
     */
    const gcBlocks = (seed: number) => {
      const r = rng(seed);
      const doc = new IY.Doc();
      doc.clientID = 1;
      const arr = doc.getArray<Y.Text>('a');
      arr.insert(0, Array.from({ length: 4 }, () => new IY.Text('t')));
      const pool = [2, 3, 5, 8];
      const pickId = (): [number, number] | null => {
        const ids: Array<[number, number]> = [];
        for (const [client, structs] of doc.store.clients) {
          for (const s of structs) if (s instanceof IY.Item && s.parent instanceof IY.Text) ids.push([client, s.id.clock + Math.floor(r() * s.length)]);
        }
        return ids.length ? ids[Math.floor(r() * ids.length)] : null;
      };
      for (let u = 0; u < 60; u++) {
        if (r() < 0.2 && arr.length > 1) {
          arr.delete(Math.floor(r() * arr.length), 1); // its children are GC'd at this transaction's cleanup
          arr.insert(Math.floor(r() * (arr.length + 1)), [new IY.Text('n')]);
          continue;
        }
        const client = pool[Math.floor(r() * pool.length)];
        let clock = IY.getState(doc.store, client);
        if (clock > 0 && r() < 0.5) clock -= 1 + Math.floor(r() * Math.min(clock, 2)); // an overlap: offset > 0
        const structs: RawClient['structs'] = [];
        for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
          const origin = pickId();
          if (!origin) break;
          structs.push({ origin, right: r() < 0.3 ? pickId() : null, content: new IY.ContentString('xyz'.slice(0, 1 + Math.floor(r() * 3))) });
        }
        if (!structs.length) continue;
        let update: Uint8Array;
        try {
          update = rawUpdate([{ client, clock, structs }], [], IY);
        } catch {
          continue;
        }
        apply(doc, update);
      }
      apply(new IY.Doc(), IY.encodeStateAsUpdate(doc));
    };

    for (let seed = 1; seed <= 60; seed++) {
      honest(seed);
      hostile(seed * 7919);
      gcBlocks(seed * 104729);
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
    expect(tally.gcOffsets).toBeGreaterThan(20); // #847: tails over a GC were compared, not merely possible
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

describe('#827 tripwire: the yjs internals the #827 bounds depend on', () => {
  it('each pinned function\'s source equals the one measured', () => {
    const actual = Object.fromEntries(Object.keys(PINNED_827_SOURCES).map((n) => [n, createHash('sha256').update(yjsSource(n)).digest('hex')]));
    const changed = Object.keys(PINNED_827_SOURCES).filter((n) => actual[n] !== PINNED_827_SOURCES[n]);
    if (changed.length) throw new Error(`${RE_VALIDATE_827}\n(changed: ${changed.map((n) => `${n} ${actual[n]}`).join(', ')})`);
  });

  it('the extraction reads whole functions (anti-vacuity: a body, its end, nothing after it)', () => {
    for (const name of Object.keys(PINNED_827_SOURCES)) {
      const body = yjsSource(name);
      expect(body.startsWith(`const ${name} = `)).toBe(true);
      expect(body.length).toBeGreaterThan(200);
      expect(body).not.toMatch(/\nconst |\nexports\./);
    }
    expect(yjsSource('transact')).toContain('cleanupTransactions(transactionCleanups, 0)');
    expect(yjsSource('cleanupContextlessFormattingGap')).toContain('item.right.deleted');
    expect(yjsSource('noSuchFunction')).toBe('<noSuchFunction: missing>');
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

  it('refuses to install when integrate, compareIDs, getItem, createID or GC is missing or changed shape', () => {
    const fake = (patch: Record<string, unknown> = {}) => {
      class Item {
        integrate(_transaction: unknown, _offset: unknown) {}
      }
      class GC {}
      return { Item, GC, compareIDs: (_a: unknown, _b: unknown) => true, getItem: (_s: unknown, _i: unknown) => null, createID: (_c: unknown, _k: unknown) => null, ...patch } as unknown as typeof Y;
    };
    expect(() => installConflictScanMeter(fake())).not.toThrow(); // the shapes the replay was written against
    expect(() => installConflictScanMeter(fake({ Item: undefined }))).toThrow(/Item.prototype.integrate.*refusing to start/);
    expect(() => installConflictScanMeter(fake({ Item: class { integrate(_t: unknown) {} } }))).toThrow(/Item.prototype.integrate/);
    expect(() => installConflictScanMeter(fake({ Item: class {} }))).toThrow(/Item.prototype.integrate/);
    expect(() => installConflictScanMeter(fake({ getItem: undefined }))).toThrow(/getItem/);
    expect(() => installConflictScanMeter(fake({ compareIDs: (_a: unknown) => true }))).toThrow(/compareIDs/);
    expect(() => installConflictScanMeter(fake({ createID: 'createID' }))).toThrow(/createID/);
    expect(() => installConflictScanMeter(fake({ GC: undefined }))).toThrow(/yjs GC is missing/); // #847: the offset branch's GC test
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

describe('#847 the meter mirrors patch C: the tail of a partly known struct over a GC', () => {
  const meter = installConflictScanMeter(Y);

  /** M1 (yjs-redo-patch.spec.ts): client 7's clocks 0..2 are a GC here (their text was deleted); the frame resends 0..5. */
  const m1 = () => {
    const base = new Y.Doc();
    base.clientID = 1;
    base.getArray('arr').insert(0, [new Y.Text('P'), new Y.Text('Q')]);
    const b0 = Y.encodeStateAsUpdate(base);
    const write = (index: number, text: string): Uint8Array => {
      const d = new Y.Doc();
      d.clientID = 7;
      Y.applyUpdate(d, b0);
      let u: Uint8Array | null = null;
      d.on('update', (x: Uint8Array) => (u = x));
      (d.getArray('arr').get(index) as Y.Text).insert(1, text);
      return u!;
    };
    const doc = new Y.Doc();
    doc.clientID = 2;
    Y.applyUpdate(doc, b0);
    Y.applyUpdate(doc, write(0, 'abc'));
    doc.getArray('arr').delete(0, 1);
    expect(doc.store.clients.get(7)!.every((s) => s instanceof Y.GC)).toBe(true);
    return { doc, frame: write(1, 'abcdef') };
  };

  it('meters the M1 frame without a meter error: 0 steps, and Yjs integrates the tail as a GC', () => {
    for (const enforce of [true, false]) {
      const { doc, frame } = m1();
      const scan = new ConflictScan(doc, enforce);
      expect(() => meter.metered(scan, () => Y.applyUpdate(doc, frame))).not.toThrow();
      expect(scan).toMatchObject({ failure: null, trip: null, items: 1, steps: 0, lastItem: 0 });
      expect(doc.store.clients.get(7)!.map((s) => [s instanceof Y.GC, s.id.clock, s.length])).toEqual([[true, 0, 6]]);
      expect((doc.getArray('arr').get(0) as Y.Text).toString()).toBe('Q');
    }
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

describe('#827 arm/disarm: a scan on one document across awaits (a load), and its own exit value', () => {
  const meter = installConflictScanMeter(Y);
  afterEach(() => expect(meter.isActive()).toBe(false));

  /** The #827 (c) inversion: cheap frames, and a state whose every load walks m·n. */
  const inversion = (m: number, n = m): Uint8Array => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText('t').insert(0, 'acde');
    const L = Array.from({ length: m }, () => ({ origin: [1, 0] as [number, number], right: [1, 3] as [number, number], content: new Y.ContentString('l') }));
    const H = Array.from({ length: n }, (_, i) => ({ origin: [1, 1] as [number, number], right: (i ? [900000, i - 1] : [1, 2]) as [number, number], content: new Y.ContentString('h') }));
    Y.applyUpdate(doc, rawUpdate([{ client: 500, clock: 0, structs: L }]));
    Y.applyUpdate(doc, rawUpdate([{ client: 900000, clock: 0, structs: H }]));
    return Y.encodeStateAsUpdate(doc);
  };

  it('counts a load into an armed doc after an await, exactly as metered() does, and disarm returns the scan', async () => {
    const state = inversion(300);
    const viaMetered = new ConflictScan(new Y.Doc(), false, Infinity);
    meter.metered(viaMetered, () => Y.applyUpdate(viaMetered.doc, state));
    const live = new Y.Doc();
    const scan = new ConflictScan(live, false, Infinity);
    meter.arm(scan);
    expect(meter.isActive()).toBe(true);
    await Promise.resolve(); // a load's DB read sits between the arm and the apply
    Y.applyUpdate(live, state);
    expect(meter.disarm(live)).toBe(scan);
    expect(scan.steps).toBe(viaMetered.steps);
    expect(scan.steps).toBeGreaterThan(300 * 300); // m·n, the inversion
    expect(meter.disarm(live)).toBeNull(); // disarm twice: nothing, never a throw
  });

  it('an enforcing load trips with its own exit value: an ordinary throw that leaves Yjs clean, the trip on the scan', () => {
    const state = inversion(300);
    const live = new Y.Doc();
    const exit = pageCompactingRefusal();
    const scan = new ConflictScan(live, true, 10_000, exit);
    meter.arm(scan);
    let thrown: unknown;
    try {
      Y.applyUpdate(live, state);
    } catch (e) {
      thrown = e;
    } finally {
      meter.disarm(live);
    }
    expect(thrown).toBe(exit);
    expect(thrown).toEqual({ reason: COLLAB_PAGE_COMPACTING_REASON });
    expect(thrown).not.toBeInstanceOf(Error); // no message: Hocuspocus logs nothing per attempt
    expect(scan.trip).toEqual({ steps: 10_001 });
    // Yjs's transact finally ran (unlike a deadline's cut): the document is consistent, merely partial
    expect((live as unknown as { _transaction: unknown })._transaction).toBeNull();
    // and a tripped armed scan stays tripped: nothing more integrates into it unmetered
    const again = new ConflictScan(live, true, 10_000, exit);
    meter.arm(again);
    again.trip = { steps: 1 };
    try {
      expect(() => Y.applyUpdate(live, state)).toThrow();
    } finally {
      meter.disarm(live);
    }
  });

  it('the default exit stays the anonymous budget value (the guard\'s frame scans are unchanged)', () => {
    const { base, frame } = twoClientsShape(50);
    const victim = copyOf(base);
    let thrown: unknown;
    try {
      meter.metered(new ConflictScan(victim, true, 100), () => Y.applyUpdate(victim, frame));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toEqual({ cccConflictScan: 'budget' });
  });

  it('refuses to arm inside a metered scope, or a document armed already; nothing is armed by a refusal', () => {
    const a = new Y.Doc();
    meter.metered(new ConflictScan(new Y.Doc(), true), () => {
      expect(() => meter.arm(new ConflictScan(a, true))).toThrow(ConflictScanArmError);
    });
    expect(meter.isActive()).toBe(false);
    meter.arm(new ConflictScan(a, true));
    try {
      expect(() => meter.arm(new ConflictScan(a, true))).toThrow(/armed already/);
    } finally {
      meter.disarm(a);
    }
  });

  it('only the armed document is metered; a metered scope on another document still counts its own', () => {
    const { base, frame } = twoClientsShape(100);
    const armedDoc = copyOf(base);
    const armedScan = new ConflictScan(armedDoc, false, Infinity);
    meter.arm(armedScan);
    try {
      const other = copyOf(base);
      Y.applyUpdate(other, frame); // not armed, not in a scope: free
      const shadow = copyOf(base);
      const own = new ConflictScan(shadow, false, Infinity);
      meter.metered(own, () => Y.applyUpdate(shadow, frame));
      expect(own.steps).toBe(100 * 100 + 99);
      expect(armedScan.steps).toBe(0);
      Y.applyUpdate(armedDoc, frame);
      expect(armedScan.steps).toBe(100 * 100 + 99);
    } finally {
      meter.disarm(armedDoc);
    }
  });

  it('a replay failure in an armed scan fails closed, as in a metered one', () => {
    const { base, frame } = twoClientsShape(5);
    const doc = copyOf(base);
    const scan = new ConflictScan(doc, false);
    const spy = jest.spyOn(Y, 'compareIDs').mockImplementation(() => {
      throw new Error('injected');
    });
    meter.arm(scan);
    try {
      expect(() => Y.applyUpdate(doc, frame)).toThrow(ConflictScanMeterError);
    } finally {
      spy.mockRestore();
      meter.disarm(doc);
    }
    expect(scan.failure).toBeInstanceOf(Error);
  });
});

function unguardedDoc(base: Y.Doc, frame: Uint8Array): Y.Doc {
  const doc = copyOf(base);
  Y.applyUpdate(doc, frame);
  return doc;
}
