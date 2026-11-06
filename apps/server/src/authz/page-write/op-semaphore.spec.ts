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
    const hold = await s.acquire();
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
