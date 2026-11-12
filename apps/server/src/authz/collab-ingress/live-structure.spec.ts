import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_MAX_LIVE_STRUCTS, softCap } from './doc-bounds';
import { capVerdict, compactionWouldHelp, type CapMeasure } from './live-structure';

/**
 * #827 (ADR 0036): `capVerdict` is THE cap rule. The update guard (a frame that grows the page, a rebuild, a probe, a
 * mirrored server write) and the load path (compaction.ts) both decide through it, so they agree on the boundaries
 * (soft: at softCap; hard: strictly past the cap), on when a structure cap is compactable, and on page-full.
 */
describe('#827 compactionWouldHelp: under the soft caps, and within what one build may rebuild', () => {
  const caps = { structs: 150_000, children: 6_000 };
  it('a page whose live structs pass COMPACT_MAX_LIVE_STRUCTS is never compacted, though under every soft cap', () => {
    expect(COMPACT_MAX_LIVE_STRUCTS).toBeLessThan(softCap(caps.structs));
    expect(compactionWouldHelp({ structs: COMPACT_MAX_LIVE_STRUCTS, children: 100 }, caps)).toBe(true);
    expect(compactionWouldHelp({ structs: COMPACT_MAX_LIVE_STRUCTS + 1, children: 100 }, caps)).toBe(false);
    // the soft caps still decide below it
    expect(compactionWouldHelp({ structs: 1_000, children: softCap(caps.children) }, caps)).toBe(false);
    // a spec may pass a smaller ceiling; the default is the production one
    expect(compactionWouldHelp({ structs: 11, children: 1 }, { ...caps, compactLive: 10 })).toBe(false);
    expect(compactionWouldHelp({ structs: 10, children: 1 }, { ...caps, compactLive: 10 })).toBe(true);
  });

  it('through capVerdict: past a hard cap over the ceiling is page-full (contentFull), never a drain', () => {
    const over = [{ reason: 'structs', n: 151, cap: 150 }] as CapMeasure[];
    const v = capVerdict(over, () => compactionWouldHelp({ structs: 60, children: 1 }, { structs: 150, children: 100, compactLive: 50 }));
    expect(v).toEqual({ reason: null, hard: false, full: true, contentFull: true });
    const control = capVerdict(over, () => compactionWouldHelp({ structs: 40, children: 1 }, { structs: 150, children: 100, compactLive: 50 }));
    expect(control).toMatchObject({ reason: 'structs', hard: true, full: false });
  });
});

describe('#827 capVerdict, the one cap rule', () => {
  const CAP = 100; // softCap(100) = 80
  const m = (reason: CapMeasure['reason'], n: number, grew?: boolean): CapMeasure => ({ reason, n, cap: CAP, ...(grew === undefined ? {} : { grew }) });
  const yes = () => true;
  const no = () => false;

  it.each([
    // [case, measures, helps, recentlyCompacted, verdict]
    ['nothing near a cap', [m('structs', 79)], yes, no, { reason: null, hard: false, full: false, contentFull: false }],
    ['soft, compaction helps: requested', [m('structs', 80)], yes, no, { reason: 'structs', hard: false, full: false, contentFull: false }],
    ['soft, compaction would not help: nothing', [m('structs', 90)], no, no, { reason: null, hard: false, full: false, contentFull: false }],
    ['at the cap is soft, not hard', [m('structs', 100)], yes, no, { reason: 'structs', hard: false, full: false, contentFull: false }],
    ['past the cap, helps: hard', [m('structs', 101)], yes, no, { reason: 'structs', hard: true, full: false, contentFull: false }],
    ['past the cap, would not help: page-full (content)', [m('structs', 101)], no, no, { reason: null, hard: false, full: true, contentFull: true }],
    ['past the cap, helps, compacted within the interval: page-full (lapses)', [m('client_ids', 101)], yes, yes, { reason: null, hard: false, full: true, contentFull: false }],
    ['soft, compacted within the interval: still requested (the interval only gates the hard cap)', [m('structs', 90)], yes, yes, { reason: 'structs', hard: false, full: false, contentFull: false }],
    ['past the cap but the frame did not grow it (a delete): soft only', [m('structs', 150, false)], yes, no, { reason: 'structs', hard: false, full: false, contentFull: false }],
    ['a step cap is always compactable (compaction rewrites the order)', [m('load_steps', 101)], no, yes, { reason: 'load_steps', hard: true, full: false, contentFull: false }],
    ['page-full requests only a step measure', [m('structs', 101), m('load_steps', 85)], no, no, { reason: 'load_steps', hard: false, full: true, contentFull: true }],
    ['a hard reason wins over an earlier soft one', [m('structs', 85), m('client_ids', 101)], yes, no, { reason: 'client_ids', hard: true, full: false, contentFull: false }],
    ['children past the cap: compaction keeps every child (helps reads them)', [m('children', 101)], no, no, { reason: null, hard: false, full: true, contentFull: true }],
  ] as const)('%s', (_case, measures, helps, recent, verdict) => {
    expect(capVerdict(measures, helps, recent)).toEqual(verdict);
  });

  it('the callbacks are lazy (each may be O(structs)) and run at most once', () => {
    const helps = jest.fn(() => true);
    const recent = jest.fn(() => false);
    capVerdict([m('structs', 10)], helps, recent);
    expect(helps).not.toHaveBeenCalled();
    expect(recent).not.toHaveBeenCalled();
    capVerdict([m('structs', 101), m('client_ids', 120), m('children', 90)], helps, recent);
    expect(helps).toHaveBeenCalledTimes(1);
    expect(recent).toHaveBeenCalledTimes(1);
    capVerdict([m('load_steps', 101)], helps, recent);
    expect(helps).toHaveBeenCalledTimes(1); // a step measure never asks
  });

  it('fitness: the guard and the load path decide caps only through capVerdict (no second boundary)', () => {
    for (const file of ['update-guard.ts', '../page-write/compaction.ts']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      expect({ file, capVerdict: /\bcapVerdict\(/.test(src) }).toEqual({ file, capVerdict: true });
      expect({ file, softCap: /\bsoftCap\(/.test(src) }).toEqual({ file, softCap: false });
      expect({ file, markPageFull: (src.match(/\bmarkPageFull\(/g) ?? []).length }).toEqual({ file, markPageFull: 1 });
    }
  });
});
