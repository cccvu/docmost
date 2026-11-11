import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFLICT_SCAN_STEPS_PER_FRAME } from './conflict-scan';
import {
  COMPACTION_ARM_DELAY_MS,
  COMPACTION_DEADLINE_MS,
  COMPACTION_MIN_INTERVAL_MS,
  C_MAX,
  E_MAX,
  LOAD_DEADLINE_MS,
  MIRROR_DEADLINE_MS,
  PROBE_DEADLINE_MS,
  PROBE_DEBOUNCE_MS,
  PROBE_MIN_INTERVAL_MS,
  READER_STEP2_MS_PER_MIB,
  READER_STEP2_SNAPSHOT_NS_PER_STRUCT,
  S_MAX,
  SOFT_CAP_FRACTION,
  T_FRAME_MS,
  W_MAX,
  readerStep2ChargeMs,
  softCap,
} from './doc-bounds';

/**
 * #827 sizing: the bounds in doc-bounds.ts against what yjs 13.6.30 costs. Measured by yjs-bounds.sizing.bench.cjs,
 * on the production base image, with the fork's own tree mounted read-only:
 *
 *   docker run --rm --network none -v <docmost>:/docmost:ro node:22-slim \
 *     node --expose-gc /docmost/apps/server/src/authz/collab-ingress/yjs-bounds.sizing.bench.cjs /docmost
 *
 * (about 90 s; a second argument runs only the benches whose name starts with it, e.g. `honest`). 2026-11-11: Node
 * 22.23.4 (production) and Node 24.21.0, x86. The full table is in doc-bounds.ts; the numbers the rules use are below.
 * A Node or yjs bump re-runs the bench and updates both, and the assertions hold the margins.
 */
const NODE22 = {
  shadowHonestMax: 306.3, // select-all of 10k paragraphs, 230k structs (past S_MAX): the slowest honest shadow apply
  shadowPaste3MiB: 260.6, // the densest 3 MiB paste (227k structs, past the caps)
  shadowOffline: 124.6, // #816's 176,000-step offline Step2
  shadowMeterAccepted: 82.1, // 998,999 steps, just under the #816 cap
  selectAllAtE: 157.1, // 10k paragraphs, 60k structs
  selectAllPastE: 551.2, // 20k paragraphs, 120k structs
  keystrokeAtC: 12.5, // 20k client ids
  keystrokePastC: 28.9, // 50k client ids
  loadCappedMetered: 165.3, // 140k structs, 20k ids
  loadMaxMetered: 348.2, // 320k structs, 20k ids (past S_MAX)
  probeCapped: 211, // encode + metered load, 140k structs
  honestLoadSteps: 40_001,
  loadNsPerStep: 95.2, // the inversion's unmetered load, slowest per step
  compactionCapped: 136.4, // 120k structs
  apiReplaceAtCaps: 306.3 + 260.6, // a select-all and a 3 MiB insert, mirrored
  readerMsPerMiB: 41.6,
  readerSnapshotNsPerStruct: 56.1,
  vmUsPerCall: 23.8,
  vmOvershootMax: 1.3,
  attackA4000: 3567, // #827 (a), one 9-byte frame
  attackC4000Load: 1413.4, // #827 (c), every load
  attackC4000Steps: 16_011_999,
};
const NODE24 = { shadowHonestMax: 295.4, shadowPaste3MiB: 227.1, selectAllAtE: 157.1, keystrokeAtC: 13.0, loadCappedMetered: 133.2, vmUsPerCall: 40.4, vmOvershootMax: 1.7 };

describe('#827 sizing: the bounds keep their margins over the measured honest work', () => {
  it('T_FRAME_MS is at least 2.5× the slowest honest shadow apply on node 22 and node 24, and under 1 s', () => {
    for (const m of [NODE22, NODE24]) expect(T_FRAME_MS).toBeGreaterThanOrEqual(2.5 * Math.max(m.shadowHonestMax, m.shadowPaste3MiB));
    expect(T_FRAME_MS).toBeGreaterThanOrEqual(2.5 * Math.max(NODE22.shadowOffline, NODE22.shadowMeterAccepted, NODE22.selectAllAtE));
    expect(T_FRAME_MS).toBeLessThanOrEqual(1_000); // an accepted frame just under it costs ~2·T once
    expect(T_FRAME_MS).toBeGreaterThan(100 * NODE22.vmOvershootMax); // the cut is far finer than the bound
  });

  it('the caps sit with at least 2× headroom over the honest work they allow, and below the shapes that stall', () => {
    expect(E_MAX).toBe(10_000);
    expect(T_FRAME_MS).toBeGreaterThanOrEqual(2 * NODE22.selectAllAtE * 2); // a select-all at E_MAX: shadow, then live
    expect(NODE22.selectAllPastE).toBeGreaterThan(NODE22.selectAllAtE * 3); // why E is capped: superlinear past it
    expect(C_MAX).toBe(20_000);
    // a keystroke at C_MAX, charged to the CPU debt (100 ms/s refill), leaves room for 5 keys/s with 1.5× to spare
    expect(5 * NODE22.keystrokeAtC * 1.5).toBeLessThan(100);
    expect(5 * NODE22.keystrokePastC).toBeGreaterThan(100); // at 50k ids an honest typist would run into debt
    expect(S_MAX).toBe(150_000);
    expect(LOAD_DEADLINE_MS).toBeGreaterThanOrEqual(8 * NODE22.loadMaxMetered);
    expect(PROBE_DEADLINE_MS).toBeGreaterThanOrEqual(7 * NODE22.probeCapped);
    expect(COMPACTION_DEADLINE_MS).toBeGreaterThanOrEqual(10 * NODE22.compactionCapped);
    expect(MIRROR_DEADLINE_MS).toBeGreaterThanOrEqual(2.5 * NODE22.apiReplaceAtCaps);
    expect(MIRROR_DEADLINE_MS).toBeGreaterThanOrEqual(T_FRAME_MS);
  });

  it('W_MAX is about 0.6 s of load steps, far above an honest page and below the inversion that stalls', () => {
    expect(W_MAX).toBe(6_000_000);
    expect((W_MAX * NODE22.loadNsPerStep) / 1e6).toBeLessThan(700);
    expect(W_MAX).toBeGreaterThanOrEqual(100 * NODE22.honestLoadSteps);
    expect(W_MAX).toBeLessThan(NODE22.attackC4000Steps);
    expect(W_MAX).toBeGreaterThanOrEqual(CONFLICT_SCAN_STEPS_PER_FRAME); // a page that took one accepted frame loads
    expect((W_MAX * 2 * NODE22.loadNsPerStep) / 1e6).toBeLessThan(LOAD_DEADLINE_MS); // the meter trips first, metered
  });

  it('the unbounded attacks the deadline cuts are multiples of T_FRAME_MS', () => {
    expect(NODE22.attackA4000).toBeGreaterThan(4 * T_FRAME_MS);
    expect(NODE22.attackC4000Load).toBeGreaterThan(T_FRAME_MS);
  });

  it('soft caps, probe pacing and compaction timing', () => {
    expect(SOFT_CAP_FRACTION).toBe(0.8);
    expect(softCap(S_MAX)).toBe(120_000);
    expect(softCap(C_MAX)).toBe(16_000);
    expect(PROBE_DEBOUNCE_MS).toBe(5_000);
    expect(PROBE_MIN_INTERVAL_MS).toBe(30_000);
    expect(PROBE_MIN_INTERVAL_MS).toBeGreaterThan(PROBE_DEBOUNCE_MS);
    expect(COMPACTION_ARM_DELAY_MS).toBe(10 * 60_000);
    expect(COMPACTION_MIN_INTERVAL_MS).toBe(10 * 60_000);
    // the deploy overlap the arming delay must outlast (ADR 0036 #827; check-infra-config pins the live values):
    // 30 s deregistration + 90 s stopTimeout + 5 min
    expect(30_000 + 90_000 + 5 * 60_000).toBeLessThan(COMPACTION_ARM_DELAY_MS);
  });

  it('a reader Step2 is charged at least 2× its measured cost', () => {
    expect(READER_STEP2_MS_PER_MIB).toBeGreaterThanOrEqual(2 * NODE22.readerMsPerMiB);
    expect(READER_STEP2_SNAPSHOT_NS_PER_STRUCT).toBeGreaterThanOrEqual(2 * NODE22.readerSnapshotNsPerStruct);
    // an honest synced copy at S_MAX (its Step2 ≲ 0.5 MB) costs a reader tens of ms, a 3 MiB crafted one ~0.27 s
    expect(readerStep2ChargeMs(480 * 1024, S_MAX)).toBeLessThan(60);
    expect(readerStep2ChargeMs(3 * 1024 * 1024, S_MAX)).toBeGreaterThan(250);
  });

  it('the bench is the one the table names (anti-vacuity: it loads the real modules and measures each case)', () => {
    const bench = readFileSync(join(__dirname, 'yjs-bounds.sizing.bench.cjs'), 'utf8');
    for (const mod of ['deadline.ts', 'conflict-scan.ts', 'conflict-scan.testkit.ts']) expect(bench).toContain(`loadTs('${mod}')`);
    for (const kind of ['vm.overhead', 'vm.cutoff', 'honest.paste', 'honest.offlineStep2', 'honest.meterAccepted', 'honest.selectAll', 'honest.typingAtIds', 'honest.loadCapped', 'honest.compaction', 'honest.readerStep2', 'attack.a', 'attack.b', 'attack.c']) {
      expect(bench).toContain(`'${kind}'`);
    }
    const table = readFileSync(join(__dirname, 'doc-bounds.ts'), 'utf8');
    expect(table).toContain('Node 22.23.4');
    expect(table).toContain('yjs-bounds.sizing.bench.cjs');
  });
});
