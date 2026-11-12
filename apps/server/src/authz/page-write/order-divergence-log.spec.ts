import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from '../collab-ingress/doc-bounds';
import { isPageCompactingRefusal } from './compaction';
import { setCompactionClockForTests } from './compaction-registry';
import { loadStableYdoc } from './heal-image';
import { memoryHealStore } from './heal-image.testkit';
import {
  COLLAB_ORDER_DIVERGENCE_TOKEN,
  logOrderDivergence,
  rateLimitedOrderDivergenceLog,
  resetLoadDivergenceLogForTests,
  type OrderDivergence,
} from './order-divergence-log';

/**
 * #840 review item 5: the load's COLLAB_ORDER_DIVERGENCE lines are rate-limited per page and outcome (one a minute, the
 * rest counted into one `log_suppressed` line), through the update guard's RateLimitedWarn window.
 */
const PAGE_A = '00000000-0000-4000-8000-0000000000a1';
const PAGE_B = '00000000-0000-4000-8000-0000000000b2';
const entry = (page: string, outcome: string): OrderDivergence => ({ page, where: 'load', structs: 3, ms: 1, suspects: [], outcome });
const parse = (line: string) => JSON.parse(line.slice(COLLAB_ORDER_DIVERGENCE_TOKEN.length + 1));

function sink() {
  const warn: string[] = [];
  const error: string[] = [];
  return { warn, error, sink: { warn: (m: string) => void warn.push(m), error: (m: string) => void error.push(m) } };
}

describe('rateLimitedOrderDivergenceLog (#840)', () => {
  it('one line per page and outcome per minute, at the level it asks for; the rest are one log_suppressed line when the window ends', () => {
    let now = 1_000_000;
    const s = sink();
    const log = rateLimitedOrderDivergenceLog(s.sink, () => now);
    for (let i = 0; i < 5; i++) log(entry(PAGE_A, 'image_missing'), true); // a client retrying try-later
    log(entry(PAGE_A, 'healed')); // another outcome on the same page is never the line held back
    log(entry(PAGE_B, 'image_missing'), true); // another page has its own window
    expect(s.error.map(parse)).toEqual([
      expect.objectContaining({ page: PAGE_A, where: 'load', outcome: 'image_missing' }),
      expect.objectContaining({ page: PAGE_B, outcome: 'image_missing' }),
    ]);
    expect(s.warn.map(parse)).toEqual([expect.objectContaining({ page: PAGE_A, outcome: 'healed' })]);

    now += 60_000; // the next line opens a new window: the count of the last one is written first
    log(entry(PAGE_A, 'image_missing'), true);
    expect(s.warn.map(parse)).toEqual([
      expect.objectContaining({ outcome: 'healed' }),
      { page: PAGE_A, where: 'load', outcome: 'log_suppressed', of: 'image_missing', count: 4 },
    ]);
    expect(s.error).toHaveLength(3); // the new window's first line, at error level again
  });

  it('the unlimited emitter (the guard and the store) still writes every line', () => {
    const s = sink();
    for (let i = 0; i < 3; i++) logOrderDivergence(entry(PAGE_A, 'heal_image'), false, s.sink);
    expect(s.warn).toHaveLength(3);
  });
});

describe('loadStableYdoc logs through it (#840)', () => {
  let restoreClock: () => void;
  beforeEach(() => {
    restoreClock = setCompactionClockForTests({ now: () => 10 * COMPACTION_MIN_INTERVAL_MS, uptimeMs: () => COMPACTION_ARM_DELAY_MS - 1 });
  });
  afterEach(() => {
    restoreClock();
    resetLoadDivergenceLogForTests();
    jest.restoreAllMocks();
  });

  it('a page answering try-later to a retrying client writes one line, not one per attempt', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    resetLoadDivergenceLogForTests();
    const bytes = Y.encodeStateAsUpdate(new Y.Doc());
    const store = memoryHealStore({ ydoc: bytes });
    store.heals.set(PAGE_A, { image: bytes, rowSha: createHash('sha256').update(bytes).digest('base64'), epoch: 1 });
    for (let i = 0; i < 10; i++) {
      let refused: unknown;
      try {
        await loadStableYdoc(new Y.Doc(), PAGE_A, bytes, store); // not armed yet: try-later
      } catch (err) {
        refused = err;
      }
      expect(isPageCompactingRefusal(refused)).toBe(true);
    }
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`${COLLAB_ORDER_DIVERGENCE_TOKEN} `));
    expect(lines.map(parse)).toEqual([expect.objectContaining({ page: PAGE_A, where: 'load', outcome: 'not_armed' })]);
  });
});
