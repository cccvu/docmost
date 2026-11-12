import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFLICT_SCAN_STEPS_PER_FRAME } from './conflict-scan';
import {
  COMPACTION_ARM_DELAY_MS,
  COMPACTION_DEADLINE_MS,
  COMPACTION_MIN_INTERVAL_MS,
  COMPACT_MAX_LIVE_STRUCTS,
  COMPACTION_GAP_FACTOR,
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
 * #827 sizing: the bounds in doc-bounds.ts against what yjs 13.6.30 costs. Measured by the sizing bench, which lives
 * with the super-repo's load kit (scripts/load/collab/yjs-bounds.sizing.bench.cjs; it loads this fork's real
 * deadline.ts and conflict-scan.ts and says how to run it), on the production base image (node:22-slim), 2026-11-11/12.
 * GRAVITON2 is the production class (Fargate ARM64; c6g.large, Node 22.23.5): every margin is held against it, the
 * slowest of three runs. Graviton3 (c7g.large) and the x86 dev box (Node 22.23.4) are kept for reference. The full
 * table is in doc-bounds.ts; the numbers the rules use are below. A Node or yjs bump re-runs the bench on Graviton2 and
 * updates both, and the assertions hold the margins.
 */
const GRAVITON2 = {
  shadowOffline: 638.4, // #816's 176,000-step offline Step2: the slowest honest shadow apply the caps admit
  liveOffline: 321.8, // the same frame's live apply (the meter's counting is the difference: issue 848)
  shadowMeterAccepted: 306.9, // 998,999 steps, just under the #816 cap
  selectAllAtE: 602.1, // shadow apply: a select-all of a page at S_MAX with E_MAX (6k) paragraphs (median of three)
  selectAllAtEFrame: 1241.8, // the whole frame: decode, shadow, live's apply
  selectAllNextE: 739.4, // 8k paragraphs at S_MAX: the next step of the sweep, past the offline Step2
  selectAllAt14k: 1365.8, // the x86-calibrated E_MAX: past 2.5× of any deadline the health check allows
  selectAllAt20k: 2321.1,
  decodeAtFrameCap: 699.3, // the pre-pass decode of the densest 3 MiB frame
  insertAtE: 300.4, // a paste of 7,502 prose paragraphs (2 MiB, more than E_MAX): an upper bound for an insert at E_MAX
  pasteProse3MiBParagraphs: 11_254, // a 3 MiB paste of 150-byte prose: over E_MAX (refused page-full)
  pasteProse3MiB500Paragraphs: 4_916, // a 3 MiB paste of 500-byte prose: fits
  keystrokeAtC: [10.7, 9.8, 13.5, 8.8], // 5k client ids, four measurements (three runs and the sweep)
  keystroke10k: 26.6,
  keystroke20k: 50.3,
  loadAtCaps: 687.7, // metered, 150k structs and 20k ids (above C_MAX: an upper bound)
  probeAtCaps: 913.9, // encode + metered load, the same page
  compactLiveRowMs: 1_600, // the row-path build at COMPACT_MAX_LIVE_STRUCTS (x86 jest 479 ms at 60k × the 4× ratio × 50/60)
  compactLiveTreeMs: 800, // the tree-path build (x86 238 ms at 60k, scaled the same way)
  honestLoadStepsPerId: 2, // an honest page walks about two steps per client id (40,001 at 20k)
  meteredNsPerStep: 790, // the inversion's metered load: 12.6 s for 16.0M steps
  readerMsPerMiB: 192.4,
  readerSnapshotNsPerStruct: 250.3,
  vmUsPerCall: 58,
  vmOvershootMax: 1.5,
  attackA4000: 11_308, // #827 (a), one small frame, unbounded
  attackC4000Load: 6_333.9, // #827 (c), every load, unbounded
  attackC4000Steps: 16_011_999,
};
const GRAVITON3 = { shadowOffline: 406.9, selectAllAtE: 422.2, loadAtCaps: 502.7, probeAtCaps: 671.9 };
const X86 = { shadowOffline: 124.9, selectAllAt14k: 319 };
/** The 5 s ALB and container health-check timeouts (infra/terraform): no single accepted frame may block that long. */
const HEALTH_TIMEOUT_MS = 5_000;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

describe('#827 sizing: the bounds keep their margins over the honest work measured on Graviton2 (production)', () => {
  it('T_FRAME_MS is at least 2.5× the slowest honest shadow apply the caps admit, and the worst accepted frame stays under the health check', () => {
    expect(T_FRAME_MS).toBeGreaterThanOrEqual(2.5 * Math.max(GRAVITON2.shadowOffline, GRAVITON2.selectAllAtE, GRAVITON2.shadowMeterAccepted));
    expect(T_FRAME_MS).toBe(1_600); // the owner's pick (set C, PR 844): 2.5 × 638 rounded up
    // the worst single stall of an accepted frame: its decode, the shadow just under T, live's re-apply (about T)
    const worstStall = GRAVITON2.decodeAtFrameCap + 2 * T_FRAME_MS;
    expect(worstStall).toBeLessThan(4_000);
    expect(worstStall).toBeLessThan(HEALTH_TIMEOUT_MS);
    expect(T_FRAME_MS).toBeGreaterThan(100 * GRAVITON2.vmOvershootMax); // the cut is far finer than the bound
    // the hosts disagree by 3.4-5×: why the calibration host is the production class, never the dev box
    expect(GRAVITON2.shadowOffline / X86.shadowOffline).toBeGreaterThan(4);
    expect(GRAVITON3.shadowOffline).toBeLessThan(GRAVITON2.shadowOffline);
  });

  it('every background deadline is ≥ 3× its honest Graviton2 work (compaction: see COMPACT_MAX_LIVE_STRUCTS) and ≤ 2 × T_FRAME_MS', () => {
    for (const d of [LOAD_DEADLINE_MS, PROBE_DEADLINE_MS, MIRROR_DEADLINE_MS, COMPACTION_DEADLINE_MS]) expect(d).toBeLessThanOrEqual(2 * T_FRAME_MS);
    expect(LOAD_DEADLINE_MS).toBeGreaterThanOrEqual(3 * GRAVITON2.loadAtCaps);
    expect(PROBE_DEADLINE_MS).toBeGreaterThanOrEqual(3 * GRAVITON2.probeAtCaps);
    expect(MIRROR_DEADLINE_MS).toBeGreaterThanOrEqual(3 * (GRAVITON2.selectAllAtE + GRAVITON2.insertAtE));
    expect(MIRROR_DEADLINE_MS).toBeGreaterThanOrEqual(T_FRAME_MS);
    // compaction: the build is bounded like a frame (an attacker picks when it runs), so the live-struct ceiling is
    // sized to the deadline: the row path 2×, the tree path 4×
    expect(COMPACTION_DEADLINE_MS).toBe(2 * T_FRAME_MS);
    expect(COMPACTION_DEADLINE_MS).toBeGreaterThanOrEqual(2 * GRAVITON2.compactLiveRowMs);
    expect(COMPACTION_DEADLINE_MS).toBeGreaterThanOrEqual(4 * GRAVITON2.compactLiveTreeMs);
    expect(COMPACT_MAX_LIVE_STRUCTS).toBe(50_000);
    expect(COMPACT_MAX_LIVE_STRUCTS).toBeGreaterThanOrEqual(2 * 25_000); // 2× the largest real page measured
    expect(COMPACT_MAX_LIVE_STRUCTS).toBeLessThan(softCap(S_MAX));
  });

  it('the caps sit below the shapes that would raise T_FRAME_MS, and keep honest typing out of debt', () => {
    // E_MAX: the select-all at S_MAX stays under the offline Step2 that sets T; the next step of the sweep does not
    expect(E_MAX).toBe(6_000);
    expect(GRAVITON2.selectAllAtE).toBeLessThan(GRAVITON2.shadowOffline);
    expect(GRAVITON2.selectAllNextE).toBeGreaterThan(GRAVITON2.shadowOffline);
    // why the x86-calibrated E_MAX (14k) went: its select-all would need a T whose 2·T alone passes the health check
    expect(2 * 2.5 * GRAVITON2.selectAllAt14k).toBeGreaterThan(HEALTH_TIMEOUT_MS);
    expect(GRAVITON2.selectAllAt14k / X86.selectAllAt14k).toBeGreaterThan(4);
    expect(GRAVITON2.selectAllAt20k / GRAVITON2.selectAllAtE).toBeGreaterThan(20_000 / 6_000); // superlinear in E
    expect(GRAVITON2.selectAllAtEFrame).toBeLessThan(T_FRAME_MS);
    // a 3 MiB paste of prose fits E_MAX from paragraphs of about 520 bytes: 150-byte ones do not, 500-byte ones do
    expect(GRAVITON2.pasteProse3MiBParagraphs).toBeGreaterThan(E_MAX);
    expect(GRAVITON2.pasteProse3MiB500Paragraphs).toBeLessThan(E_MAX);
    expect(S_MAX).toBe(150_000);
    expect(C_MAX).toBe(5_000);
    // a keystroke at C_MAX, charged to the CPU debt (100 ms/s refill): 5 keys/s with 1.5× to spare at the median, and
    // under the refill at the slowest measurement; at 10k ids an honest typist would run into debt
    expect(5 * median(GRAVITON2.keystrokeAtC) * 1.5).toBeLessThan(100);
    expect(5 * Math.max(...GRAVITON2.keystrokeAtC)).toBeLessThan(100);
    expect(5 * GRAVITON2.keystroke10k).toBeGreaterThan(100);
  });

  it('W_MAX is the #816 frame cap: a refused load costs under a second on Graviton2, far above an honest page, below the inversion', () => {
    expect(W_MAX).toBe(1_000_000);
    expect(W_MAX).toBeGreaterThanOrEqual(CONFLICT_SCAN_STEPS_PER_FRAME); // a page that took one accepted frame loads
    expect((W_MAX * GRAVITON2.meteredNsPerStep) / 1e6).toBeLessThan(1_000);
    expect((W_MAX * GRAVITON2.meteredNsPerStep) / 1e6).toBeLessThan(LOAD_DEADLINE_MS); // the meter trips first
    expect(W_MAX).toBeGreaterThanOrEqual(50 * GRAVITON2.honestLoadStepsPerId * C_MAX); // ~100× an honest page at C_MAX
    expect(W_MAX).toBeLessThan(GRAVITON2.attackC4000Steps);
  });

  it('the unbounded attacks the deadline cuts reach past T_FRAME_MS; the load inversion is the step budget\'s', () => {
    expect(GRAVITON2.attackA4000).toBeGreaterThan(T_FRAME_MS); // and grows with D: the deadline is what bounds it
    expect(GRAVITON2.attackC4000Load).toBeGreaterThan(LOAD_DEADLINE_MS); // W_MAX trips first (the W_MAX case above)
  });

  it('soft caps, probe pacing and compaction timing', () => {
    expect(SOFT_CAP_FRACTION).toBe(0.8);
    expect(softCap(S_MAX)).toBe(120_000);
    expect(softCap(C_MAX)).toBe(4_000);
    expect(PROBE_DEBOUNCE_MS).toBe(5_000);
    expect(PROBE_MIN_INTERVAL_MS).toBe(30_000);
    expect(PROBE_MIN_INTERVAL_MS).toBeGreaterThan(PROBE_DEBOUNCE_MS);
    expect(COMPACTION_ARM_DELAY_MS).toBe(10 * 60_000);
    expect(COMPACTION_MIN_INTERVAL_MS).toBe(10 * 60_000);
    // back to back across pages: a gap of twice the last one's duration, so compaction holds at most a third of the process
    expect(COMPACTION_GAP_FACTOR).toBe(2);
    expect(1 / (1 + COMPACTION_GAP_FACTOR)).toBeLessThanOrEqual(1 / 3);
    // the deploy overlap the arming delay must outlast (ADR 0036 #827; check-infra-config pins the live values):
    // 30 s deregistration + 90 s stopTimeout + 5 min
    expect(30_000 + 90_000 + 5 * 60_000).toBeLessThan(COMPACTION_ARM_DELAY_MS);
  });

  it('a reader Step2 is charged at least 2× its Graviton2 cost', () => {
    expect(READER_STEP2_MS_PER_MIB).toBeGreaterThanOrEqual(2 * GRAVITON2.readerMsPerMiB);
    // 2× to the measurement's resolution (the three runs spread 222-250 ns)
    expect(READER_STEP2_SNAPSHOT_NS_PER_STRUCT).toBeGreaterThanOrEqual(0.99 * 2 * GRAVITON2.readerSnapshotNsPerStruct);
    // an honest synced copy at S_MAX (its Step2 ≲ 0.5 MB) costs a reader about a quarter second, a 3 MiB crafted one
    // about 1.3 s of the 2 s burst
    expect(readerStep2ChargeMs(480 * 1024, S_MAX)).toBeLessThan(300);
    expect(readerStep2ChargeMs(3 * 1024 * 1024, S_MAX)).toBeGreaterThan(1_200);
  });

  it('the table names its bench and the Node it was measured on', () => {
    const table = readFileSync(join(__dirname, 'doc-bounds.ts'), 'utf8');
    expect(table).toContain('Graviton2');
    expect(table).toContain('Node 22.23.5');
    expect(table).toContain('yjs-bounds.sizing.bench.cjs');
  });
});
