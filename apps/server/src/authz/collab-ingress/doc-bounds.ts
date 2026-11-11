/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * Every #827 bound on Yjs work, in one place. #816 metered the conflict walk of one frame; the paths it cannot count
 * (formatting cleanup after a remote delete, struct splits, load-order inversion, per-transaction client-id cost, an
 * honest select-all over a huge page) are bounded here by a wall-clock deadline on the work (deadline.ts), by per-page
 * structure caps that compaction restores, and by a step budget on loads and probes (the #816 meter, armed on the doc).
 *
 * Calibrated by yjs-bounds.sizing.bench.cjs on the production image's Node (doc-bounds.spec.ts says how to run it and
 * holds the numbers below against these constants). 2026-11-11, x86 (svr-2-dell), yjs 13.6.30; Node 22.23.4 =
 * node:22-slim (production), Node 24.21.0 for comparison. Times in ms unless marked.
 *
 *   the deadline (vm timeout)                         node 22        node 24
 *     cost per call                                   23.8 µs        40.4 µs
 *     cut overshoot, busy loop / Yjs apply            −0.7 … +1.3    −0.7 … +1.7
 *   honest frames: the shadow apply T_FRAME_MS bounds (pre-pass decode and live's apply are outside it)
 *     3 MiB paste, 8-char paragraphs (227k structs)   261            227      (past S_MAX/E_MAX: an upper envelope)
 *     3 MiB paste, 20-char half-bold (192k structs)   185            174
 *     #816 offline Step2 (176,000 steps)              125            138
 *     a frame the meter accepts (998,999 steps)        82             81
 *     select-all, 10k paragraphs, 60k structs         157            157
 *     select-all, 10k paragraphs, 230k structs        306            295      (past S_MAX)
 *     select-all, 20k paragraphs, 120k structs        551            541      (past E_MAX)
 *     select-all, 50k paragraphs, 150k structs       2335           3028      (past E_MAX)
 *   the E_MAX decision (honest.selectAllAtS): a select-all delete of a page AT S_MAX (150k structs), by its live
 *   children E; shadow apply / the whole frame (decode + shadow + live's apply), median of 3 (13k–15k: the median of
 *   three such runs; node 22 varied ≤ 1%, node 24 up to 11%)
 *     E = 10,000                                    206 / 419      206 / 412
 *     E = 12,500                                    273 / 544      283 / 569
 *     E = 13,000                                    288 / 578      282 / 565
 *     E = 14,000  ← E_MAX                           319 / 638      315 / 627
 *     E = 15,000                                    350 / 703      350 / 698
 *     E = 17,500                                    442 / 906      512 / 1059
 *     E = 20,000                                    574 / 1147     615 / 1199    (superlinear in E: why E is capped)
 *   a ~3 MiB paste of prose into an empty page (honest.pasteProse: two bold runs a paragraph), whole frame
 *     150-byte paragraphs: 11,131 paragraphs, 111k structs   306      306      (fits E_MAX 14k; was past 10k)
 *     210 / 300 / 500 bytes: 9,124 / 7,209 / 4,916 paragraphs  266 / 210 / 150
 *   keystroke (decode + shadow + live), by client ids:  5k 3.2, 20k 12.5, 50k 28.9   (node 24: 3.2, 13.0, 28.5)
 *   load of a page with 20k ids, metered (count mode): 80k structs 99, 140k 165, 320k 348 (node 24: 88, 133, 313);
 *     honest walk steps 40,001; encode (the probe's other half) 28 / 46 / 97
 *   compaction rebuild (read out, build, encode): 60k structs 77, 120k 136, 300k 285   (node 24: 65, 113, 259)
 *   reader Step2: Y.snapshot 51–56 ns per struct, snapshotContainsUpdate 37–42 ms/MiB   (node 24: 38–58, 32–39)
 *   attacks, unbounded → under a 250 ms deadline (cut at, node 22)
 *     (a) 9-byte delete, D=1000/2000/4000 next to 20k tombstones   764 / 1,608 / 3,567   → 250.5 / 249.6 / 250.6
 *     (b) 20k ascending delete ranges, 50k/100k structs after       352 / 959              → 250.7 / 250.7
 *     (c) inversion M=N=1000/2000/4000 (frames ≤ 5.6 each): load   96 / 362 / 1,413 (88–95 ns per step; metered
 *         183 / 723 / 2,910, about 180 ns per step), M·N + 2,999 steps                       → ran 92 / 250.7 / 250.7
 *
 * Not measured: Graviton (production is ARM). Each rule below keeps at least the stated margin over the x86 Node 22
 * number; the strike rule (a first deadline is a 1013, only a repeat is a 4422) absorbs a one-off GC or CPU stall.
 */

const MINUTE = 60_000;

// --- deadlines (deadline.ts): a timeout means "outcome unknown", so the work's document is discarded

/**
 * The shadow apply of one frame. ≥ 2.5× the slowest honest shadow apply measured (319 ms, a select-all at S_MAX and
 * E_MAX; 306 ms past S_MAX; 261 ms the densest 3 MiB paste). An accepted frame just under it costs about 2·T of the
 * process once (the shadow, then live), after which the sender's CPU debt applies.
 */
export const T_FRAME_MS = 800;
/**
 * The vm backstop of a load (the step budget W_MAX trips first on every walk it counts). ≥ 8× the slowest honest load
 * measured (348 ms metered, 320k structs: past S_MAX).
 */
export const LOAD_DEADLINE_MS = 3_000;
/** The probe (encode the shadow, load it metered into a scratch doc). ≥ 7× the honest probe at the caps (211 ms). */
export const PROBE_DEADLINE_MS = 1_500;
/**
 * A server-local update mirrored into the shadow (an API write, a Redis-relayed or reconcile update): a timeout
 * discards the shadow and requests compaction, never refuses. ≥ 2.5× an API replace at the caps (a select-all plus a
 * 3 MiB insert: ~570 ms).
 */
export const MIRROR_DEADLINE_MS = 1_500;
/** A compaction build (read out, rebuild, digest check, encode). ≥ 10× the measured rebuild at the caps (136 ms). */
export const COMPACTION_DEADLINE_MS = 3_000;

// --- per-page structure caps (counted in the guard, O(touched))

/**
 * Structs in the page's store. An honest select-all delete at S_MAX and E_MAX costs 0.32 s of shadow apply (0.64 s of
 * frame), a load ~0.17 s, a compaction ~0.15 s. The largest real page measured is 0.52 MB, about 25k structs: 6× headroom.
 */
export const S_MAX = 150_000;
/**
 * Client ids in the page's store. Yjs pays O(ids) per transaction (yjs#415): a keystroke costs 12.5 ms at 20k ids and
 * 28.9 ms at 50k, where the CPU debt (100 ms/s refill) breaks even near 45k. Honest pages hold one id per editing
 * session: thousands at most.
 */
export const C_MAX = 20_000;
/**
 * Live children of any one element (the root included). Yjs's delete-set merge splices once per run of a client's
 * struct array, so a select-all costs ~c·E·S, and superlinear in E (the table: at S_MAX, 0.42 s of frame at 10k, 1.15 s
 * at 20k). The LARGEST E whose honest select-all at S_MAX stays ≤ ~0.7 s of frame on Node 22 (638 ms; 15k is 703) and
 * whose shadow apply (319 ms) keeps T_FRAME_MS's 2.5× margin (15k's 350 does not). So a 3 MiB paste
 * of prose fits: paragraphs from ~110 bytes of text (about 3 MiB / 14k encoded), where 10k refused anything under ~150.
 * Compaction keeps every live child: a page past E is page-full, never drained.
 */
export const E_MAX = 14_000;
/**
 * Walk steps (the #816 meter's count) of a full load: ~0.3 s of Yjs at 88–95 ns per step (6M measured 1.2 s live with
 * the meter counting before it tripped, so 3M keeps a refused load near 0.6 s). An honest page at the caps walks 40k
 * (75× headroom); the inversion attack grows as M·N.
 */
export const W_MAX = 3_000_000;
/**
 * Past this fraction of a cap, compaction is requested for the next unload; at the hard cap, the page drains and
 * compacts. Either only when compaction would bring the page back under this fraction of every cap (its live structs
 * and the live children of each element, which compaction keeps); otherwise growth past the hard cap is page-full.
 */
export const SOFT_CAP_FRACTION = 0.8;

// --- the probe: in residency, catches what the caps cannot see (inversion, reorder) within one interval

/** Accepted growth arms a probe this long after the last accepted frame. */
export const PROBE_DEBOUNCE_MS = 5_000;
/** At most one probe per document per this interval (and one at a time per process). */
export const PROBE_MIN_INTERVAL_MS = 30_000;

// --- compaction

/**
 * No compaction until the process has been up this long. A rolling deploy overlaps old and new tasks for about 2–3 min
 * after the new one is healthy (30 s deregistration, 90 s stopTimeout, the health grace), and a pre-#827 task has no
 * epoch rule: it would merge a stale copy into a compacted page (duplicated content). check-infra-config pins
 * `deregistration_delay + stopTimeout + 5 min < COMPACTION_ARM_DELAY_MS`.
 */
export const COMPACTION_ARM_DELAY_MS = 10 * MINUTE;
/** At most one compaction per page per this interval: a page whose visible content is over a cap cannot loop. */
export const COMPACTION_MIN_INTERVAL_MS = 10 * MINUTE;
/** Compactions in flight per process. */
export const COMPACTIONS_IN_FLIGHT_MAX = 1;

// --- reader Step2: charged to the reader's CPU debt, never refused on size below the frame cap

/** Per MiB of a reader's Step2 (decode and the covered-by-live check): 2× the measured 41.6 ms/MiB. */
export const READER_STEP2_MS_PER_MIB = 84;
/** Per struct of the live page (the snapshot the check takes): over 2× the measured 56.1 ns. */
export const READER_STEP2_SNAPSHOT_NS_PER_STRUCT = 120;

/** What a reader's Step2 of `bytes` against a live page of `structs` is charged, in ms. */
export function readerStep2ChargeMs(bytes: number, structs: number): number {
  return (READER_STEP2_MS_PER_MIB * bytes) / (1024 * 1024) + (READER_STEP2_SNAPSHOT_NS_PER_STRUCT * structs) / 1e6;
}

/** The soft cap of `cap` (requests compaction at the next unload). */
export function softCap(cap: number): number {
  return Math.floor(cap * SOFT_CAP_FRACTION);
}
