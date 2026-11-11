// CCC collab integration — NOT upstream Docmost code (#827, ADR 0036). Not a test: the measurement behind the #827
// constants in doc-bounds.ts (the table there, and doc-bounds.spec.ts, say how to run it and what it found). It loads
// the fork's own yjs and the REAL deadline.ts / conflict-scan.ts / conflict-scan.testkit.ts (transpiled in memory,
// never written), and measures, on the Node it runs on:
//   vm       the deadline's cost per call and how close its cut lands, on a busy loop and on a Yjs apply;
//   honest   the slowest honest work the bounds must never refuse: a 3 MiB paste, the #816 offline Step2, a frame the
//            meter accepts just under its 1M steps, a select-all delete and a keystroke at the caps, the load (probe)
//            and the compaction rebuild of a page at the caps, a reader's Step2;
//   attack   #827 (a) formatting cleanup, (b) struct splits, (c) load-order inversion: their unbounded cost.
// Usage: node --expose-gc yjs-bounds.sizing.bench.cjs <docmost dir> [only-prefix]
'use strict';
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const DOCMOST = path.resolve(process.argv[2] || '.');
const ONLY = process.argv[3] || '';
const SERVER = path.join(DOCMOST, 'apps/server');
const HERE = path.join(SERVER, 'src/authz/collab-ingress');
const req = createRequire(path.join(SERVER, 'package.json'));
const Y = req('yjs');
const ts = req('typescript');

/** A fork TS module, transpiled in memory; `yjs` and sibling modules resolve to the instances loaded here. */
const loaded = new Map();
function loadTs(file) {
  const full = path.join(HERE, file);
  if (loaded.has(full)) return loaded.get(full);
  const out = ts.transpileModule(readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const module = { exports: {} };
  loaded.set(full, module.exports);
  const localRequire = (id) => (id === 'yjs' ? Y : id.startsWith('./') ? loadTs(id.slice(2) + '.ts') : req(id));
  new Function('exports', 'require', 'module', '__filename', '__dirname', out.outputText)(module.exports, localRequire, module, full, HERE);
  loaded.set(full, module.exports);
  return module.exports;
}
const { runWithDeadline, isDeadlineExceeded } = loadTs('deadline.ts');
const { ConflictScan, installConflictScanMeter } = loadTs('conflict-scan.ts');
const kit = loadTs('conflict-scan.testkit.ts');
const meter = installConflictScanMeter(Y);

const gc = global.gc || (() => {});
const now = () => Number(process.hrtime.bigint()) / 1e6;
const r1 = (x) => Math.round(x * 10) / 10;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = (fn) => {
  gc();
  const t0 = now();
  const v = fn();
  return [now() - t0, v];
};
const out = (o) => console.log(JSON.stringify(o));
const MiB = 1024 * 1024;
const BIG = 600_000; // a deadline no honest case reaches: the honest numbers include the vm's own cost

/** A page by `client`: `n` paragraphs, each `text` with `bold` chars marked; returns the doc. */
function page(n, { client = 1, text = 'paragraph text', bold = 0, start = 0 } = {}) {
  const doc = new Y.Doc();
  doc.clientID = client;
  addParagraphs(doc, n, { text, bold, at: start });
  return doc;
}
function addParagraphs(doc, n, { text = 'paragraph text', bold = 0, at = null } = {}) {
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    const ps = [];
    for (let i = 0; i < n; i++) {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, text.slice(bold)); // a prelim text: insert at 0 only (reading its length warns)
      if (bold) t.insert(0, text.slice(0, bold), { bold: true });
      ps.push(p);
    }
    frag.insert(at === null ? frag.length : at, ps);
  });
}
/** `n` paragraphs, each with `marks` alternately bold and italic runs of text: about 2·marks + 2 structs each. */
function richPage(n, marks) {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.transact(() => {
    const ps = [];
    for (let i = 0; i < n; i++) {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      for (let m = marks - 1; m >= 0; m--) t.insert(0, 'run' + m + ' ', m % 2 ? { italic: true } : { bold: true });
      ps.push(p);
    }
    doc.getXmlFragment('default').insert(0, ps);
  });
  return doc;
}
const copy = (doc) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(doc));
  return d;
};
const structs = (doc) => {
  let s = 0;
  for (const a of doc.store.clients.values()) s += a.length;
  return s;
};
/** The update one local transaction on `doc` emits. */
const captured = (doc, fn) => {
  let u = null;
  const h = (x) => (u = u ? Y.mergeUpdates([u, x]) : x);
  doc.on('update', h);
  fn();
  doc.off('update', h);
  return u;
};
/**
 * What the guard spends on a writer's frame, approximately: the pre-pass decode, the shadow apply inside the meter and
 * the deadline (counting), the post-apply inspection (the transaction's changed types and its delete set), then live's
 * apply with an `update` listener that encodes (Hocuspocus broadcasts each update). Times in ms.
 */
function guardCost(base, update) {
  const shadow = copy(base);
  const live = copy(base);
  live.on('update', (u) => u.length);
  const [decode] = time(() => Y.decodeUpdate(update).structs.length);
  const scan = new ConflictScan(shadow, false, Infinity);
  let inspected = 0;
  shadow.on('afterTransaction', (tr) => {
    for (const t of tr.changed.keys()) inspected += t._length | 0;
    tr.deleteSet.clients.forEach((ds) => (inspected += ds.length));
  });
  const [apply] = time(() => meter.metered(scan, () => runWithDeadline(() => Y.applyUpdate(shadow, update), BIG)));
  const [liveApply] = time(() => Y.applyUpdate(live, update));
  return { bytes: update.length, decode: r1(decode), shadow: r1(apply), live: r1(liveApply), total: r1(decode + apply + liveApply), steps: scan.steps, inspected };
}

/** `fn` under a 250 ms deadline: whether it was cut, and when (ms). */
const CUT_MS = 250;
function cut(fn) {
  const t0 = now();
  try {
    runWithDeadline(fn, CUT_MS);
    return { cutAt: null, ranMs: r1(now() - t0) };
  } catch (e) {
    if (!isDeadlineExceeded(e)) throw e;
    return { cutAt: r1(now() - t0) };
  }
}

const benches = {
  // --- the deadline itself
  'vm.overhead'() {
    const n = 20_000;
    for (let i = 0; i < 2000; i++) runWithDeadline(() => i, 1000);
    const t0 = now();
    for (let i = 0; i < n; i++) runWithDeadline(() => i, 1000);
    const timed = ((now() - t0) / n) * 1000;
    const t1 = now();
    for (let i = 0; i < n; i++) (() => i)();
    out({ kind: 'vm.overhead', usPerCall: r1(timed), usDirect: r1(((now() - t1) / n) * 1000) });
  },
  'vm.cutoff'() {
    for (const ms of [100, 250, 500, 1000]) {
      const over = [];
      for (let i = 0; i < 5; i++) {
        const t0 = now();
        try {
          runWithDeadline(() => {
            for (;;);
          }, ms);
        } catch (e) {
          if (!isDeadlineExceeded(e)) throw e;
        }
        over.push(now() - t0 - ms);
      }
      out({ kind: 'vm.cutoff', on: 'busy-loop', ms, overshootMin: r1(Math.min(...over)), overshootMedian: r1(median(over)), overshootMax: r1(Math.max(...over)) });
    }
    const { base, frame } = kit.twoClientsShape(6000);
    for (const ms of [100, 250, 500]) {
      const over = [];
      for (let i = 0; i < 5; i++) {
        const doc = copy(base);
        const t0 = now();
        try {
          runWithDeadline(() => Y.applyUpdate(doc, frame), ms);
          over.push(NaN);
        } catch (e) {
          if (!isDeadlineExceeded(e)) throw e;
          over.push(now() - t0 - ms);
        }
      }
      out({ kind: 'vm.cutoff', on: 'yjs-apply-36M-steps', ms, overshootMin: r1(Math.min(...over)), overshootMedian: r1(median(over)), overshootMax: r1(Math.max(...over)) });
    }
  },

  // --- honest work the bounds must accept
  'honest.paste'() {
    // three densities of a ~3 MiB paste into a 2000-paragraph page, by another client
    for (const [name, text, bold] of [['tiny', 'abcdefgh', 0], ['formatted20', 'twenty chars of text', 10], ['kib', 'x'.repeat(1024), 0]]) {
      const base = page(2000);
      let n = 1000;
      let u;
      for (;;) {
        const e = copy(base);
        e.clientID = 7;
        u = captured(e, () => addParagraphs(e, n, { text, bold, at: 1000 }));
        if (u.length >= 2.85 * MiB && u.length <= 3 * MiB) break; // the largest paste under PAGE_MAX_YDOC_BYTES
        n = Math.floor(n * ((2.95 * MiB) / u.length));
      }
      const after = copy(base);
      Y.applyUpdate(after, u);
      out({ kind: 'honest.paste', density: name, paragraphs: n, structsAdded: structs(after) - structs(base), pageStructs: structs(after), ...guardCost(base, u) });
    }
  },
  'honest.offlineStep2'() {
    // #816's worst honest frame (176k steps): an offline run of 500 edits merged where another editor (a lower client
    // id) had pasted 2000 paragraphs. 88 of the edits are paragraphs entered at the paste's spot, each placed before the
    // last (each walks the paste: 2000 steps); the other 412 type into them (no walk).
    const base = page(200);
    const a = copy(base);
    a.clientID = 900;
    const b = copy(base);
    b.clientID = 100_000;
    const at = 100;
    const paste = captured(a, () => addParagraphs(a, 2000, { text: 'pasted paragraph', at }));
    const offline = captured(b, () => {
      const frag = b.getXmlFragment('default');
      for (let i = 0; i < 88; i++) {
        b.transact(() => {
          const p = new Y.XmlElement('paragraph');
          p.insert(0, [new Y.XmlText()]);
          frag.insert(at, [p]);
        });
        for (let k = 0; k < (i < 60 ? 5 : 4); k++) b.transact(() => frag.get(at).get(0).insert(k, 'w'));
      }
    });
    const server = copy(base);
    Y.applyUpdate(server, paste);
    out({ kind: 'honest.offlineStep2', edits: 88 + 60 * 5 + 28 * 4, ...guardCost(server, offline) });
  },
  'honest.meterAccepted'() {
    // a frame the #816 meter accepts just under its cap: 999 × 999 + 998 = 998,999 steps
    const { base, frame } = kit.twoClientsShape(999);
    out({ kind: 'honest.meterAccepted', ...guardCost(base, frame) });
  },
  'honest.selectAll'() {
    // select-all delete (and an API replace's fragment.delete): local on live, and remote on the shadow / live / peers
    for (const [paragraphs, text, bold, marks] of [[10_000, 'a paragraph of text', 0, 0], [10_000, 'a paragraph of bold text', 6, 0], [20_000, 'a paragraph of bold text', 6, 0], [50_000, 'a paragraph', 0, 0], [10_000, '', 0, 7], [10_000, '', 0, 12]]) {
      const base = marks ? richPage(paragraphs, marks) : page(paragraphs, { text, bold });
      const editor = copy(base);
      editor.clientID = 9;
      const frag = editor.getXmlFragment('default');
      const [local, del] = time(() => captured(editor, () => frag.delete(0, frag.length)));
      out({ kind: 'honest.selectAll', paragraphs, bold: !!bold, marks, structs: structs(base), localDelete: r1(local), ...guardCost(base, del) });
    }
  },
  'honest.typingAtIds'() {
    // a keystroke on a page whose structs come from C client ids (one character each)
    for (const ids of [5_000, 20_000, 50_000]) {
      const base = page(200);
      const t = base.getXmlFragment('default').get(0).get(0);
      const clients = [];
      for (let i = 0; i < ids; i++) clients.push({ client: 1_000_000 + i, clock: 0, structs: [{ origin: [1, 0], right: null, content: new Y.ContentString('c') }] });
      // origin = the first character's id is wrong for nested text; use the paragraph text's first char
      const first = t._start.id;
      for (const c of clients) c.structs[0].origin = [first.client, first.clock];
      Y.applyUpdate(base, kit.rawUpdate(clients));
      const editor = copy(base);
      editor.clientID = 42;
      const et = editor.getXmlFragment('default').get(0).get(0);
      const key = captured(editor, () => et.insert(1, 'k'));
      const reps = [];
      for (let i = 0; i < 5; i++) reps.push(guardCost(base, key).total);
      out({ kind: 'honest.typingAtIds', ids, structs: structs(base), keystrokeMs: r1(median(reps)) });
    }
  },
  'honest.loadCapped'() {
    // a page at the struct and id caps: its encode (a probe) and its load into a fresh doc, metered in count mode
    for (const [paragraphs, ids] of [[10_000, 20_000], [20_000, 20_000], [50_000, 20_000]]) {
      const base = page(paragraphs, { text: 'a paragraph of bold text', bold: 6 });
      const t = base.getXmlFragment('default').get(0).get(0);
      const first = t._start.id;
      const clients = [];
      for (let i = 0; i < ids; i++) clients.push({ client: 1_000_000 + i, clock: 0, structs: [{ origin: [first.client, first.clock], right: null, content: new Y.ContentString('c') }] });
      Y.applyUpdate(base, kit.rawUpdate(clients));
      const [encode, bytes] = time(() => Y.encodeStateAsUpdate(base));
      const fresh = new Y.Doc();
      const scan = new ConflictScan(fresh, false, Infinity);
      const [load] = time(() => meter.metered(scan, () => runWithDeadline(() => Y.applyUpdate(fresh, bytes), BIG)));
      const plain = new Y.Doc();
      const [unmetered] = time(() => Y.applyUpdate(plain, bytes));
      out({ kind: 'honest.loadCapped', paragraphs, ids, structs: structs(base), bytes: bytes.length, encode: r1(encode), meteredLoad: r1(load), load: r1(unmetered), probe: r1(encode + load), steps: scan.steps });
    }
  },
  'honest.compaction'() {
    // the rebuild of a capped page: read it out as JSON, build a fresh doc from it (one transaction), encode it
    for (const paragraphs of [10_000, 20_000, 50_000]) {
      const base = page(paragraphs, { text: 'a paragraph of bold text', bold: 6 });
      const [ms, bytes] = time(() => {
        const json = base.getXmlFragment('default').toArray().map((p) => ({ type: p.nodeName, content: p.toArray().map((t) => t.toDelta()) }));
        const fresh = new Y.Doc();
        fresh.transact(() => {
          const ps = json.map((p) => {
            const el = new Y.XmlElement(p.type);
            const t = new Y.XmlText();
            el.insert(0, [t]);
            t.applyDelta(p.content[0]);
            return el;
          });
          fresh.getXmlFragment('default').insert(0, ps);
          fresh.getMap('__ccc_lineage').set('epoch', 1);
        });
        return Y.encodeStateAsUpdate(fresh);
      });
      out({ kind: 'honest.compaction', paragraphs, structs: structs(base), ms: r1(ms), bytesOut: bytes.length });
    }
  },
  'honest.readerStep2'() {
    // a reader's synced copy sends its state as Step2 (mostly the delete set); what charging it should cover:
    // the decode and Y.snapshot of the live page (the guard's covered-by-live check)
    for (const paragraphs of [10_000, 50_000]) {
      const base = page(paragraphs, { text: 'a paragraph of bold text', bold: 6 });
      const frag = base.getXmlFragment('default');
      base.transact(() => {
        for (let i = frag.length - 2; i >= 0; i -= 2) frag.delete(i, 1); // a fragmented delete set
      });
      const step2 = Y.encodeStateAsUpdate(base);
      const [snap] = time(() => Y.snapshot(base));
      const [contains] = time(() => Y.snapshotContainsUpdate(Y.snapshot(base), step2));
      out({ kind: 'honest.readerStep2', structs: structs(base), bytes: step2.length, snapshotMs: r1(snap), containsMs: r1(contains), nsPerStruct: r1((snap * 1e6) / structs(base)), msPerMiB: r1((contains / step2.length) * 1024 * 1024) });
    }
  },

  // --- the #827 attacks, unbounded
  'attack.a'() {
    // a remote delete of D unmerged reverse-typed structs next to T tombstones, in a paragraph's text with formatting
    for (const [D, T] of [[1000, 20_000], [2000, 20_000], [4000, 20_000]]) {
      const doc = page(1, { text: 'ab', bold: 1, client: 5 });
      const t = () => doc.getXmlFragment('default').get(0).get(0);
      for (let i = 0; i < T; i++) t().insert(1, 'x');
      t().delete(1, T);
      for (let i = 0; i < D; i++) t().insert(1, 'y');
      const attacker = copy(doc);
      attacker.clientID = 6;
      const frame = captured(attacker, () => attacker.getXmlFragment('default').get(0).get(0).delete(1, D));
      const victim = copy(doc);
      victim.getXmlFragment('default');
      const cutVictim = copy(doc);
      cutVictim.getXmlFragment('default');
      const [ms] = time(() => Y.applyUpdate(victim, frame));
      out({ kind: 'attack.a', D, T, frameBytes: frame.length, ms: r1(ms), ...cut(() => Y.applyUpdate(cutVictim, frame)) });
    }
  },
  'attack.b'() {
    // a 200k-character struct, S structs after it in the same client's array, then N ascending delete ranges inside it
    for (const [S, N] of [[50_000, 20_000], [100_000, 20_000]]) {
      const doc = new Y.Doc();
      doc.clientID = 5;
      const t = doc.getText('t');
      t.insert(0, 'x'.repeat(200_000));
      for (let i = 0; i < S; i++) t.insert(200_000, 'y');
      const attacker = copy(doc);
      attacker.clientID = 6;
      const frame = captured(attacker, () => attacker.transact(() => {
        for (let i = N - 1; i >= 0; i--) attacker.getText('t').delete(2 * i, 1);
      }));
      const victim = copy(doc);
      const cutVictim = copy(doc);
      const [ms] = time(() => Y.applyUpdate(victim, frame));
      out({ kind: 'attack.b', S, ranges: N, frameBytes: frame.length, ms: r1(ms), ...cut(() => Y.applyUpdate(cutVictim, frame)) });
    }
  },
  'attack.c'() {
    // load-order inversion: `a c d e` by client 1; client 500 places M siblings from a to e; client 900000 reverse-types
    // N items between c and d. Each frame is cheap; a load integrates 900000 first, so each sibling walks all N.
    for (const MN of [1000, 2000, 4000]) {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const t = doc.getText('t');
      t.insert(0, 'acde');
      const L = [];
      for (let i = 0; i < MN; i++) L.push({ origin: [1, 0], right: [1, 3], content: new Y.ContentString('l') });
      const H = [];
      for (let i = 0; i < MN; i++) H.push({ origin: [1, 1], right: i ? [900000, i - 1] : [1, 2], content: new Y.ContentString('h') });
      const fL = kit.rawUpdate([{ client: 500, clock: 0, structs: L }]);
      const fH = kit.rawUpdate([{ client: 900000, clock: 0, structs: H }]);
      const [msL] = time(() => Y.applyUpdate(doc, fL));
      const [msH] = time(() => Y.applyUpdate(doc, fH));
      const state = Y.encodeStateAsUpdate(doc);
      const fresh = new Y.Doc();
      const scan = new ConflictScan(fresh, false, Infinity);
      const [metered] = time(() => meter.metered(scan, () => Y.applyUpdate(fresh, state)));
      const plain = new Y.Doc();
      const [load] = time(() => Y.applyUpdate(plain, state));
      out({ kind: 'attack.c', M: MN, N: MN, frameL: r1(msL), frameH: r1(msH), stateBytes: state.length, loadSteps: scan.steps, loadMs: r1(load), meteredLoadMs: r1(metered), nsPerStep: r1((load * 1e6) / Math.max(1, scan.steps)), same: plain.getText('t').toString() === t.toString(), ...cut(() => Y.applyUpdate(new Y.Doc(), state)) });
    }
  },
};

out({ node: process.version, yjs: JSON.parse(readFileSync(req.resolve('yjs/package.json'), 'utf8')).version, arch: process.arch });
for (const [name, run] of Object.entries(benches)) if (name.startsWith(ONLY)) run();
