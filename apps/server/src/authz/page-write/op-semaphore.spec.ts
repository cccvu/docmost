import { OpSemaphore, OpSemaphoreTimeout } from './op-semaphore';

/** #616: the per-process bound on conditional page operations — bounded concurrency, bounded wait, no leaks. */
describe('OpSemaphore', () => {
  it('admits up to `max` at once and hands a freed slot to the next waiter (FIFO)', async () => {
    const s = new OpSemaphore(2, 1000);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.inUse).toBe(2);
    const order: string[] = [];
    const w3 = s.acquire().then((r) => (order.push('w3'), r));
    const w4 = s.acquire().then((r) => (order.push('w4'), r));
    r1();
    const r3 = await w3;
    expect(s.inUse).toBe(2);
    r2();
    const r4 = await w4;
    expect(order).toEqual(['w3', 'w4']);
    r3();
    r4();
    expect(s.inUse).toBe(0);
  });

  it('refuses a waiter after `waitMs` and forgets it (a later release does not grant a dead waiter)', async () => {
    const s = new OpSemaphore(1, 15);
    const r1 = await s.acquire();
    await expect(s.acquire()).rejects.toBeInstanceOf(OpSemaphoreTimeout);
    r1();
    expect(s.inUse).toBe(0);
    const r2 = await s.acquire();
    expect(s.inUse).toBe(1);
    r2();
  });

  it('a per-call wait overrides the constructor wait (#626: two gates sharing one admission budget)', async () => {
    const s = new OpSemaphore(1, 60_000);
    const r1 = await s.acquire();
    const started = Date.now();
    await expect(s.acquire(15)).rejects.toBeInstanceOf(OpSemaphoreTimeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    r1();
    const r2 = await s.acquire(0); // a free slot is granted at once, whatever the budget left
    expect(s.inUse).toBe(1);
    r2();
  });

  it('a double release never frees a slot someone else holds', async () => {
    const s = new OpSemaphore(1, 1000);
    const r1 = await s.acquire();
    r1();
    const r2 = await s.acquire();
    r1(); // stale second release
    expect(s.inUse).toBe(1);
    r2();
    expect(s.inUse).toBe(0);
  });

  it('run() releases the slot whether the work resolves or throws', async () => {
    const s = new OpSemaphore(1, 1000);
    await expect(s.run(async () => 'ok')).resolves.toBe('ok');
    await expect(s.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(s.inUse).toBe(0);
  });

  it('rejects a nonsensical bound', () => {
    expect(() => new OpSemaphore(0, 10)).toThrow();
  });
});

/**
 * #716: the converter's small interactive writes jump the queue (`urgent`), with aging so a steady stream of them can
 * delay a large waiter by about `agingMs`, never starve it. Grants happen synchronously on release, so these are
 * deterministic: no timers on the pass path, the clock is injected.
 */
describe('OpSemaphore urgent queue (#716)', () => {
  /** Record grant order; returns each acquire's release once granted. */
  const grantsInOrder = (s: OpSemaphore, order: string[], name: string, urgent: boolean) =>
    s.acquire(10_000, { urgent }).then((r) => (order.push(name), r));

  it('serves an urgent waiter before EARLIER normal waiters, and urgent waiters FIFO among themselves', async () => {
    const s = new OpSemaphore(1, 10_000);
    const hold = await s.acquire();
    const order: string[] = [];
    const n1 = grantsInOrder(s, order, 'n1', false);
    const u1 = grantsInOrder(s, order, 'u1', true);
    const n2 = grantsInOrder(s, order, 'n2', false);
    const u2 = grantsInOrder(s, order, 'u2', true);
    hold();
    (await u1)();
    (await u2)();
    (await n1)();
    (await n2)();
    expect(order).toEqual(['u1', 'u2', 'n1', 'n2']);
    expect(s.inUse).toBe(0);
  });

  it('with no urgent waiter the queue is plain FIFO (the default API is unchanged)', async () => {
    const s = new OpSemaphore(1, 10_000, { agingMs: 5 });
    const hold = await s.acquire();
    const order: string[] = [];
    const a = grantsInOrder(s, order, 'a', false);
    const b = grantsInOrder(s, order, 'b', false);
    hold();
    (await a)();
    (await b)();
    expect(order).toEqual(['a', 'b']);
  });

  it('aging: a normal waiter that has waited agingMs is granted before a newer urgent one', async () => {
    let t = 0;
    const s = new OpSemaphore(1, 10_000, { agingMs: 3_000, now: () => t });
    // An urgent holder: #731, an urgent waiter that waits out a NORMAL holder's turn is not passed over by aging.
    const hold = await s.acquire(10_000, { urgent: true });
    const order: string[] = [];
    const n1 = grantsInOrder(s, order, 'n1', false); // waits from t=0
    t = 2_999;
    const u1 = grantsInOrder(s, order, 'u1', true);
    const u2 = grantsInOrder(s, order, 'u2', true);
    hold(); // n1 has waited 2 999 ms < 3 000: urgent first
    const r1 = await u1;
    t = 3_000;
    r1(); // n1 has now waited 3 000 ms: it goes ahead of u2
    const r2 = await n1;
    r2();
    (await u2)();
    expect(order).toEqual(['u1', 'n1', 'u2']);
  });

  it('without agingMs, urgent waiters are always served first', async () => {
    let t = 0;
    const s = new OpSemaphore(1, 10_000, { now: () => t });
    const hold = await s.acquire();
    const order: string[] = [];
    const n1 = grantsInOrder(s, order, 'n1', false);
    t = 1e9;
    const u1 = grantsInOrder(s, order, 'u1', true);
    hold();
    (await u1)();
    (await n1)();
    expect(order).toEqual(['u1', 'n1']);
  });

  it('an urgent waiter that times out is removed: a later release grants the next waiter, not the dead one', async () => {
    const s = new OpSemaphore(1, 10_000);
    const hold = await s.acquire();
    const order: string[] = [];
    await expect(s.acquire(5, { urgent: true })).rejects.toBeInstanceOf(OpSemaphoreTimeout);
    const n1 = grantsInOrder(s, order, 'n1', false);
    hold();
    (await n1)();
    expect(order).toEqual(['n1']);
    expect(s.inUse).toBe(0);
  });
});

/**
 * #716: pause/resume — the worker's reload after a kill holds the slot without doing anyone's work, so it is given back
 * to the waiters (capped per waiter), instead of being folded into every waiter's wait. Fake timers (Date included): no
 * real time passes, so the expiry instants are exact.
 */
describe('OpSemaphore pause/resume (#716)', () => {
  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());
  const settled = (p: Promise<unknown>) => {
    const s = { done: false, rejected: false };
    p.then(
      () => (s.done = true),
      () => ((s.done = true), (s.rejected = true)),
    );
    return s;
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('a paused waiter does not expire, and gets the paused time back (up to the cap)', async () => {
    const s = new OpSemaphore(1, 100, { pauseCreditMs: 50 });
    const held = await s.acquire();
    const w = settled(s.acquire());
    jest.advanceTimersByTime(60); // 40 ms of its wait left
    s.pause();
    jest.advanceTimersByTime(30); // paused: credited back
    s.resume();
    jest.advanceTimersByTime(39); // now 129: the deadline is 100 + 30 credited = 130, 1 ms left
    await flush();
    expect(w.done).toBe(false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(w).toEqual({ done: true, rejected: true });
    held();
  });

  it('the credit is capped per waiter: a long pause gives back at most pauseCreditMs', async () => {
    const s = new OpSemaphore(1, 100, { pauseCreditMs: 50 });
    const held = await s.acquire();
    const w = settled(s.acquire());
    jest.advanceTimersByTime(90);
    s.pause();
    jest.advanceTimersByTime(500);
    s.resume(); // deadline 100 + 50 = 150; now 590: expires at once
    await flush();
    expect(w).toEqual({ done: true, rejected: true });
    held();
  });

  it('without pauseCreditMs a pause gives nothing back: a waiter whose wait ran out during it expires on resume', async () => {
    const s = new OpSemaphore(1, 100);
    const held = await s.acquire();
    const w = settled(s.acquire());
    s.pause();
    jest.advanceTimersByTime(150);
    await flush();
    expect(w.done).toBe(false); // no timer fires while paused
    s.resume();
    await flush();
    expect(w).toEqual({ done: true, rejected: true });
    held();
  });

  it('a waiter that joins during the pause is credited only the part it sat through', async () => {
    const s = new OpSemaphore(1, 100, { pauseCreditMs: 1_000 });
    const held = await s.acquire();
    s.pause();
    jest.advanceTimersByTime(40);
    const w = settled(s.acquire()); // joins at 40, deadline 140
    jest.advanceTimersByTime(20);
    s.resume(); // credited 20 → deadline 160
    jest.advanceTimersByTime(99); // now 159
    await flush();
    expect(w.done).toBe(false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(w.rejected).toBe(true);
    held();
  });

  it('a grant during or after a pause still works, and pause/resume are idempotent', async () => {
    const s = new OpSemaphore(1, 100, { pauseCreditMs: 50 });
    const held = await s.acquire();
    const w = s.acquire();
    s.pause();
    s.pause();
    held(); // granted while paused
    const r = await w;
    s.resume();
    s.resume();
    jest.advanceTimersByTime(1_000);
    expect(s.inUse).toBe(1);
    r();
    expect(s.inUse).toBe(0);
  });
});

/**
 * #731 D3: aging never chains past an urgent waiter. In the A1 run the abuser's deadline-length conversions kept aged
 * large waiters queued (its next one, the legit writer's, the mid writer's), and aging granted them ahead of a small
 * write after the running conversion ended, so a small write waited the running conversion AND an aged one, past its
 * 8 s wait (503 engine_busy): the small class had collapsed to FIFO. Now an urgent waiter that has waited through a
 * normal holder's turn goes first, so it waits out at most ONE normal holder; a normal waiter that has aged still never
 * starves. Fake timers (Date included) drive the semaphore's own clock: no real time passes, every instant is exact.
 */
describe('OpSemaphore: an urgent waiter waits out at most one normal holder (#731)', () => {
  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const record = (s: OpSemaphore, order: string[], name: string, urgent: boolean, waitMs = 1e9) =>
    s.acquire(waitMs, { urgent }).then((r) => (order.push(name), r));

  it('an urgent waiter behind a NORMAL holder goes before an aged normal waiter', async () => {
    const s = new OpSemaphore(1, 1e9, { agingMs: 3_000 });
    const hold = await s.acquire(); // a normal holder (a large conversion)
    const order: string[] = [];
    const n1 = record(s, order, 'n1', false); // t=0
    jest.advanceTimersByTime(1_000);
    const u1 = record(s, order, 'u1', true); // t=1 000, behind the normal holder
    jest.advanceTimersByTime(6_000); // n1 has aged (7 000 ≥ 3 000)
    hold();
    (await u1)();
    (await n1)();
    expect(order).toEqual(['u1', 'n1']);
  });

  it('aging still passes an urgent waiter that has waited behind URGENT holders only — once, then it goes first', async () => {
    const s = new OpSemaphore(1, 1e9, { agingMs: 3_000 });
    const hold = await s.acquire(1e9, { urgent: true }); // a small conversion holds the worker
    const order: string[] = [];
    const n1 = record(s, order, 'n1', false);
    const n2 = record(s, order, 'n2', false);
    jest.advanceTimersByTime(3_500);
    const u1 = record(s, order, 'u1', true);
    hold(); // n1 aged, u1 waited behind a small holder only: n1
    const r1 = await n1;
    expect(order).toEqual(['n1']);
    r1(); // u1 has now waited out n1's turn: it goes before n2, aged as n2 is
    (await u1)();
    (await n2)();
    expect(order).toEqual(['n1', 'u1', 'n2']);
  });

  it('the A1 pattern at production bounds: every small write is served within one running conversion + one reload', async () => {
    // CONTENT_PARSE_LIMITS: wait 8 s, aging 3 s, reload credit 3.5 s; every large conversion runs to the 7 s deadline,
    // is killed, and the replacement worker loads for 2 s while the killed conversion still holds the slot.
    const WAIT = 8_000;
    const DEADLINE = 7_000;
    const RELOAD = 2_000;
    const SMALL_MS = 300;
    const END = 180_000;
    const s = new OpSemaphore(1, WAIT, { agingMs: 3_000, pauseCreditMs: 3_500 });
    const smallWaits: number[] = [];
    let smallBusy = 0;
    const largeGrants = new Map<string, number>();
    let agedLargePassed = 0; // anti-vacuity: grants made to a small while an aged large waited
    const large = async (who: string, offset: number) => {
      await sleep(offset);
      while (Date.now() < END) {
        let release: () => void;
        try {
          release = await s.acquire();
        } catch (err) {
          expect(err).toBeInstanceOf(OpSemaphoreTimeout);
          continue; // the abuser retries at once; so the queue always holds aged large waiters
        }
        largeGrants.set(who, (largeGrants.get(who) ?? 0) + 1);
        await sleep(DEADLINE); // killed at the deadline…
        s.pause(); // …and the slot is held through the reload, which nobody's wait is charged for
        await sleep(RELOAD);
        s.resume();
        release();
      }
    };
    // Whether an aged large waiter is queued (white-box, for the anti-vacuity count only).
    const agedLargeQueued = () =>
      (s as unknown as { waiters: Array<{ at: number }> }).waiters.some((w) => Date.now() - w.at >= 3_000);
    const small = async () => {
      // The small writer: every 5 s (A1_SMALL_EVERY_S), one at a time (its principal's own turn), joining right
      // after a large conversion started is the worst case and happens every round.
      while (Date.now() < END) {
        const joined = Date.now();
        try {
          const release = await s.acquire(WAIT, { urgent: true });
          smallWaits.push(Date.now() - joined);
          if (agedLargeQueued()) agedLargePassed++;
          await sleep(SMALL_MS);
          release();
        } catch (err) {
          expect(err).toBeInstanceOf(OpSemaphoreTimeout);
          smallBusy++;
        }
        await sleep(Math.max(0, 5_000 - (Date.now() - joined)));
      }
    };
    // Several large principals (three abusers, the legit and mid writers), each re-queueing at once.
    const actors = ['abuse1', 'abuse2', 'abuse3', 'legit', 'mid'].map((who, i) => large(who, i * 10));
    actors.push(sleep(100).then(small));
    await jest.advanceTimersByTimeAsync(END + 60_000);
    await Promise.all(actors);
    expect(smallBusy).toBe(0);
    expect(smallWaits.length).toBeGreaterThanOrEqual(15);
    // One running conversion (≤ the deadline) + one reload, never a second, aged conversion after it. The small writer
    // re-joins right after its own turn, so it lands behind a freshly started large conversion: the worst case, every round.
    expect(Math.max(...smallWaits)).toBeLessThanOrEqual(DEADLINE + RELOAD);
    expect(smallWaits.filter((w) => w > DEADLINE).length).toBeGreaterThanOrEqual(10);
    expect(agedLargePassed).toBeGreaterThanOrEqual(10); // the case that used to chain really happened
    // …and the small writer takes only its own turns: the worker still runs a large conversion back to back with them
    // (each round is one 9 s large turn + at most one 0.3 s small one).
    const largeTotal = [...largeGrants.values()].reduce((a, b) => a + b, 0);
    expect(largeTotal).toBeGreaterThanOrEqual(Math.floor(END / (DEADLINE + RELOAD + SMALL_MS)));
  });

  it('a normal waiter never starves under a continuous urgent stream: it waits the smalls that waited out the last normal holder, then goes', async () => {
    const s = new OpSemaphore(1, 1e9, { agingMs: 3_000 });
    let stop = false;
    const grants: Array<[string, number]> = [];
    const hold = await s.acquire(); // a normal holder, 0 → 2 000
    const n = s.acquire().then((r) => (grants.push(['L', Date.now()]), r));
    // Three small principals in a closed loop (each re-queues as soon as it is done): never an empty urgent queue.
    const smallLoop = async (who: string, at: number) => {
      await sleep(at);
      while (!stop) {
        const release = await s.acquire(1e9, { urgent: true });
        grants.push([who, Date.now()]);
        await sleep(500);
        release();
      }
    };
    const loops = [smallLoop('s1', 200), smallLoop('s2', 300), smallLoop('s3', 400)];
    await jest.advanceTimersByTimeAsync(2_000);
    hold(); // s1, s2, s3 have waited out this normal holder: they go first, then L (aged at 3 000)
    await jest.advanceTimersByTimeAsync(1_500);
    const releaseN = await n;
    expect(grants).toEqual([
      ['s1', 2_000],
      ['s2', 2_500],
      ['s3', 3_000],
      ['L', 3_500],
    ]);
    stop = true;
    releaseN();
    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.all(loops);
  });

  /**
   * Both bounds over a seeded random mix (no expiry, so every waiter is eventually granted and can be checked):
   *   - every urgent waiter waits out at most ONE normal holder (the one holding when it joined, or one granted after);
   *   - once a normal waiter is the oldest and has aged, at most K urgent grants precede it (K urgent callers, one
   *     waiter each): its wait no longer depends on how fast the urgent stream is.
   */
  it('a seeded random mix keeps both bounds', async () => {
    let seed = 731;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const AGING = 3_000;
    const K = 3;
    const END = 400_000;
    const s = new OpSemaphore(1, 1e9, { agingMs: AGING });
    let holderNormal = false;
    type Pending = { normal: boolean; joined: number; normalsSeen: number; headAgedFrom?: number; urgentAfter: number };
    const pending: Pending[] = [];
    let worstNormalsSeen = 0;
    let worstUrgentAfterAged = 0;
    let urgentBehindNormal = 0; // anti-vacuity
    let agedNormalWithUrgent = 0; // anti-vacuity
    const headNormal = () => pending.find((p) => p.normal);
    const actor = async (normal: boolean) => {
      while (Date.now() < END) {
        await sleep(normal ? between(1, 4_000) : between(1, 1_500));
        const me: Pending = { normal, joined: Date.now(), normalsSeen: holderNormal ? 1 : 0, urgentAfter: 0 };
        pending.push(me);
        const release = await s.acquire(1e9, { urgent: !normal });
        const now = Date.now();
        pending.splice(pending.indexOf(me), 1);
        if (normal) {
          for (const p of pending) if (!p.normal) p.normalsSeen++;
          if (me.headAgedFrom !== undefined) worstUrgentAfterAged = Math.max(worstUrgentAfterAged, me.urgentAfter);
          if (pending.some((p) => !p.normal) && now - me.joined >= AGING) agedNormalWithUrgent++;
        } else {
          worstNormalsSeen = Math.max(worstNormalsSeen, me.normalsSeen);
          if (me.normalsSeen > 0) urgentBehindNormal++;
          const h = headNormal();
          if (h && h.headAgedFrom !== undefined) h.urgentAfter++;
        }
        holderNormal = normal;
        // The oldest normal waiter, once it has aged, starts counting the urgent grants that precede it.
        const tick = () => {
          const h = headNormal();
          if (h && h.headAgedFrom === undefined && Date.now() - h.joined >= AGING) h.headAgedFrom = Date.now();
        };
        tick();
        const hold = normal ? between(500, 7_000) : between(20, 1_500);
        const step = setInterval(tick, 10);
        await sleep(hold);
        clearInterval(step);
        tick();
        release();
      }
    };
    const actors = [...Array.from({ length: K }, () => actor(false)), ...Array.from({ length: 3 }, () => actor(true))];
    await jest.advanceTimersByTimeAsync(END + 200_000);
    await Promise.all(actors);
    expect(urgentBehindNormal).toBeGreaterThanOrEqual(50);
    expect(agedNormalWithUrgent).toBeGreaterThanOrEqual(20);
    expect(worstNormalsSeen).toBe(1);
    expect(worstUrgentAfterAged).toBeLessThanOrEqual(K);
  });
});
