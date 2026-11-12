/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * Every #827 bound on Yjs work, in one place. #816 metered the conflict walk of one frame; the paths it cannot count
 * (formatting cleanup after a remote delete, struct splits, load-order inversion, per-transaction client-id cost, an
 * honest select-all over a huge page) are bounded here by a wall-clock deadline on the work (deadline.ts), by per-page
 * structure caps that compaction restores, and by a step budget on loads and probes (the #816 meter, armed on the doc).
 *
 * Calibrated by the sizing bench (yjs-bounds.sizing.bench.cjs, kept with the super-repo's load kit) on the production
 * image (node:22-slim, yjs 13.6.30), 2026-11-11/12, on three hosts: Graviton2 (c6g.large, Neoverse N1, Node 22.23.5),
 * the PRODUCTION class (Fargate ARM64); Graviton3 (c7g.large) for comparison; x86 (svr-2-dell, Node 22.23.4), the
 * box first used, kept for reference. Graviton2 runs honest Yjs work 3.4-5x slower than that x86 box. Graviton2 figures
 * are the slowest of three runs (they agreed within about 2%); a busy-loop on the other vCPU added 3-30% (loads and
 * probes most). doc-bounds.spec.ts holds these numbers against the constants. Times in ms unless marked.
 *
 *                                                       Graviton2   Graviton3   x86
 *   the deadline (vm timeout): cost per call            58 µs       36 µs       24 µs
 *     cut overshoot, busy loop / Yjs apply              −0.8 … +1.5             −0.7 … +1.3
 *   honest frames: the shadow apply T_FRAME_MS bounds (pre-pass decode and live's apply are outside it)
 *     #816 offline Step2 (176,000 steps)                638         407         125   ← the slowest the caps admit
 *     a frame the meter accepts (998,999 steps)         307         181          82
 *     3 MiB paste, 8-char paragraphs (227k structs)    1078         694         261   (past S_MAX and E_MAX: refused)
 *     3 MiB paste, 20-char half-bold (192k structs)     807         554         185   (past S_MAX and E_MAX: refused)
 *     select-all, 10k paragraphs, 60k structs           632         413         157   (past E_MAX)
 *     select-all, 10k paragraphs, 230k structs         1237         849         306   (past S_MAX and E_MAX)
 *     select-all, 50k paragraphs, 150k structs         9485        5932        2335   (past E_MAX)
 *   the E_MAX decision: a select-all delete of a page AT S_MAX (150k structs), by its live children E; shadow apply /
 *   the whole frame (decode + shadow + live's apply), median of 3
 *     E = 2,000                                     416 / 845                103 / 206
 *     E = 4,000                                     496 / 1033   340 / 726   120 / 238
 *     E = 6,000  ← E_MAX                            602 / 1242   422 / 878   149 / 294
 *     E = 8,000                                     739 / 1517   500 / 1054  184 / 365
 *     E = 10,000                                    914 / 1863   604 / 1266  224 / 447
 *     E = 14,000 (the x86-calibrated E_MAX)        1366 / 2763   879 / 1809  319 / 638
 *     E = 20,000                                   2321 / 4665               574 / 1147   (superlinear in E: why E is capped)
 *   honest pastes by frame size (Graviton2: shadow / whole frame, live children); the frame cap is PAGE_MAX_YDOC_BYTES
 *     1 MiB: prose 150 B 162 / 497 (3,751); 300 B 119 / 355 (2,409); 8-char 343 / 974 (27,047)
 *     2 MiB: prose 150 B 300 / 893 (7,502); 300 B 215 / 633 (4,819); 8-char 657 / 1880 (51,983)
 *     3 MiB: prose 150 B 431 / 1294 (11,254); 300 B 314 / 917 (7,229); 500 B 249 / 685 (4,916); 8-char decode 699
 *   keystroke (decode + shadow + live), by client ids, Graviton2: 2k 6.1, 5k 8.8-13.5, 10k 26.6, 20k 40-50, 50k 104
 *     (x86: 2k 1.4, 5k 2.9, 10k 6.3, 20k 12.7, 50k 29)
 *   load of a page, metered (count mode), and the probe (encode + metered load), Graviton2:
 *     60k structs / 5k ids 311, probe 426; 100k / 10k 472, probe 619; 150k / 20k 688, probe 914;
 *     320k / 20k (past S_MAX) 2100, probe 2558   (x86: 150k 175, probe 223)
 *   walk steps: ~400 ns each unmetered, ~790 ns metered (Graviton2; x86 95 / ~190); an honest page walks about 2 per id
 *   compaction: the bench's rebuild (read out, build, encode), Graviton2: 60k structs 354, 120k 543, 150k 617
 *     (x86 85 / 148 / 154). The real buildCompacted (digest checks included), 6k paragraphs, measured on x86 in jest:
 *     60k live structs 238 ms from the live tree (unload), 479 ms from the row's content (TiptapTransformer, after a
 *     refused load); 120k 477 / 1050. At the bench's Graviton2/x86 ratio (3.7-4x), 50k live structs is about 0.8 s
 *     from the tree and 1.6 s from the row: COMPACT_MAX_LIVE_STRUCTS.
 *   reader Step2: Y.snapshot ≤ 250 ns per struct, snapshotContainsUpdate ≤ 192 ms/MiB (Graviton2; x86 60, 42)
 *   the stall paths the deadline exists for: measured unbounded and cut within about 1 ms of a 250 ms deadline on every
 *   host (the numbers stay in ADR 0036's private copy)
 *
 * The worst single stall an accepted frame can cause: the pre-pass decode (≤ 0.7 s at the 3 MiB frame cap) + the shadow
 * apply just under T_FRAME_MS + live's re-apply of it (about T_FRAME_MS): about 3.9 s on Graviton2, under the 5 s
 * ALB and container health-check timeouts. Every background deadline is at most 2 × T_FRAME_MS, so no other bounded
 * operation blocks longer. The strike rule (a first deadline is a 1013, only a repeat is a 4422) absorbs a one-off GC
 * or CPU stall.
 */

const MINUTE = 60_000;

// --- deadlines (deadline.ts): a timeout means "outcome unknown", so the work's document is discarded

/**
 * The shadow apply of one frame. ≥ 2.5× the slowest honest shadow apply the caps admit on Graviton2: 638 ms, #816's
 * offline Step2 (its live apply is 320 ms; the meter's counting is the rest, issue 848 would cut it); a select-all at
 * S_MAX and E_MAX is 602 ms. An accepted frame just under it costs about 2·T of the process once (the shadow, then
 * live), after which the sender's CPU debt applies (burst 2 s, refill 0.1 s per second: about a tenth of a core per
 * account, whatever T is).
 */
export const T_FRAME_MS = 1_600;
/**
 * The vm backstop of a load (the step budget W_MAX trips first on every walk it counts: ~0.8 s metered on Graviton2).
 * ≥ 3× the honest load at the caps on Graviton2 (688 ms metered, 150k structs and 20k ids), ≤ 2 × T_FRAME_MS.
 */
export const LOAD_DEADLINE_MS = 2_100;
/**
 * The probe (encode the shadow, load it metered into a scratch doc). ≥ 3× the honest probe at the caps on Graviton2
 * (914 ms, 150k structs; a timeout drains the page, with no strike), ≤ 2 × T_FRAME_MS.
 */
export const PROBE_DEADLINE_MS = 2_800;
/**
 * A server-local update mirrored into the shadow (an API write, a Redis-relayed or reconcile update): a timeout
 * discards the shadow and requests compaction, never refuses. ≥ 3× an API replace at the caps on Graviton2: a select-all
 * at S_MAX and E_MAX (602 ms) plus an insert of up to E_MAX paragraphs (≤ 300 ms: 7,502 paragraphs of prose measured
 * 300), ≤ 2 × T_FRAME_MS.
 */
export const MIRROR_DEADLINE_MS = 2_800;
/**
 * A compaction build (read out, rebuild, digest check, encode). = 2 × T_FRAME_MS, the most any background deadline may
 * block; ≥ 2× the row-path build at COMPACT_MAX_LIVE_STRUCTS on Graviton2 (~1.6 s) and ≥ 4× the tree-path build (~0.8 s).
 * An attacker controls when compaction triggers, so its build is bounded like a frame, never longer.
 */
export const COMPACTION_DEADLINE_MS = 3_200;

// --- per-page structure caps (counted in the guard, O(touched))

/**
 * Structs in the page's store. On Graviton2 an honest select-all delete at S_MAX and E_MAX costs 0.60 s of shadow apply
 * (1.24 s of frame), a load at the caps 0.69 s, a probe 0.91 s. The largest real page measured is 0.52 MB, about 25k
 * structs: 6× headroom. Compaction sheds history (deleted structs); live structs (what it keeps) are capped lower, at
 * COMPACT_MAX_LIVE_STRUCTS.
 */
export const S_MAX = 150_000;
/**
 * Client ids in the page's store. Yjs pays O(ids) per transaction (yjs#415): on Graviton2 a keystroke costs 8.8-13.5 ms
 * at 5k ids, 26.6 ms at 10k and 40-50 ms at 20k. At 5k, five keys a second spend 44-68 ms of the CPU debt's 100 ms/s
 * refill (≥ 1.5× to spare at the median); at 10k they would spend 133. Honest pages hold one id per editing session;
 * compaction resets them to one, and is requested from the soft cap (4k).
 */
export const C_MAX = 5_000;
/**
 * Live children of any one element (the root included). Yjs's delete-set merge splices once per run of a client's
 * struct array, so a select-all costs ~c·E·S, and superlinear in E (the table: at S_MAX on Graviton2, 0.85 s of frame
 * at 2k, 1.86 s at 10k, 4.7 s at 20k). At 6k, the select-all at S_MAX (602 ms of shadow) stays under the offline Step2
 * that sets T_FRAME_MS (638 ms); at 8k it would not (739). A 3 MiB paste of prose fits from paragraphs of about 520
 * bytes of text (3 MiB / 6k); shorter paragraphs fit in proportionally smaller pastes (1 MiB from about 175 bytes).
 * Compaction keeps every live child: a page past E is page-full, never drained.
 */
export const E_MAX = 6_000;
/**
 * Walk steps (the #816 meter's count) of a full load: ~0.4 s of Yjs on Graviton2 (≤ 400 ns a step), ~0.8 s metered, which
 * is what a refused load costs before the meter trips. The floor is the #816 frame cap (a page that took one accepted
 * frame loads); an honest page at C_MAX walks about 10k (100× headroom); the inversion attack grows as M·N.
 */
export const W_MAX = 1_000_000;
/**
 * Live structs (the structs compaction keeps) past which a page is NOT compacted: its rebuild must fit
 * COMPACTION_DEADLINE_MS on Graviton2 with margin. At 50k live structs the row-path build (after a refused load:
 * TiptapTransformer plus the schema digests) is about 1.6 s (2×) and the tree-path build at unload about 0.8 s (4×).
 * The largest real page (about 25k structs) has 2× headroom. It is a hard cap on live structs, decided by the cap rule
 * (`capVerdict`, a hard-only measure): a frame that grows a page past it is page-full (refused; deletes and replaces
 * pass), and a load, rebuild, probe or mirrored write that finds a page past it marks it page-full for the API, so every
 * compaction (each path: a structure cap, the step budget, a probe, a refused load's row build) rebuilds at most about
 * this much. A page already past it (written before #827, or one API write over it) is never drained for a structure
 * cap (`compactionWouldHelp` says no); a row build of such a page that runs out of time is not retried for the same
 * bytes (`startRowCompaction`).
 */
export const COMPACT_MAX_LIVE_STRUCTS = 50_000;
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
/**
 * Back to back across pages: the next compaction starts no sooner than this many times the last one's duration after
 * it ended, so compaction holds at most about a third of the process even when one account owns many pages that each
 * qualify (the per-page interval and the one-in-flight limit alone allow one right after another).
 */
export const COMPACTION_GAP_FACTOR = 2;

// --- reader Step2: charged to the reader's CPU debt, never refused on size below the frame cap

/** Per MiB of a reader's Step2 (decode and the covered-by-live check): over 2× the 192 ms/MiB measured on Graviton2. */
export const READER_STEP2_MS_PER_MIB = 400;
/** Per struct of the live page (the snapshot the check takes): 2× the 250 ns measured on Graviton2. */
export const READER_STEP2_SNAPSHOT_NS_PER_STRUCT = 500;

/** What a reader's Step2 of `bytes` against a live page of `structs` is charged, in ms. */
export function readerStep2ChargeMs(bytes: number, structs: number): number {
  return (READER_STEP2_MS_PER_MIB * bytes) / (1024 * 1024) + (READER_STEP2_SNAPSHOT_NS_PER_STRUCT * structs) / 1e6;
}

/** The soft cap of `cap` (requests compaction at the next unload). */
export function softCap(cap: number): number {
  return Math.floor(cap * SOFT_CAP_FRACTION);
}
