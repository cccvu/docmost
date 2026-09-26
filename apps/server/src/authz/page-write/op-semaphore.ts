/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * A small in-process counting semaphore with a bounded wait. The conditional page operations hold a pooled
 * connection inside a transaction while upstream code may take a second one (reads it does through its own
 * `this.db`, the PDP's lineage read), so their concurrency is capped per process to keep them from exhausting the
 * pool that serves every other request. A caller that cannot get a slot within `waitMs` is refused
 * (`OpSemaphoreTimeout`) rather than queued without bound; the controller answers that with a retryable 503.
 */
export class OpSemaphoreTimeout extends Error {
  constructor() {
    super('no conditional-operation slot became free in time');
    this.name = 'OpSemaphoreTimeout';
  }
}

export class OpSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly waitMs: number,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error('OpSemaphore: max must be a positive integer');
  }

  /** Slots currently held (for tests and diagnostics). */
  get inUse(): number {
    return this.active;
  }

  /** Resolves with a release function once a slot is held; rejects with `OpSemaphoreTimeout` after `waitMs`. */
  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new OpSemaphoreTimeout());
      }, this.waitMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.push(grant);
    });
  }

  /** Run `fn` holding a slot; the slot is released however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent: a double release must never free a slot someone else holds
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
