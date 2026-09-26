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
