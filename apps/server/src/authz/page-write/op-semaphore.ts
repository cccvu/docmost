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

/** A queued `acquire`: its grant, and when it began waiting (for aging). */
interface Waiter {
  grant: () => void;
  at: number;
  /** #716: when its wait runs out (wall clock), the time it joined, and the pause time already credited to it. */
  deadline: number;
  joined: number;
  credited: number;
  timer?: ReturnType<typeof setTimeout>;
  expire: () => void;
  /**
   * #731: an urgent waiter that has already waited through a NORMAL holder's turn. Aging never passes it over again,
   * so an urgent waiter waits out at most one normal holder (see `next()`).
   */
  behindNormal: boolean;
}

export interface OpSemaphoreOptions {
  /**
   * #716: with urgent waiters present, a NORMAL waiter that has waited at least this long is granted first, so a
   * steady stream of urgent work can delay normal work by about this much, never starve it. Absent: urgent waiters are
   * always served first (still FIFO among themselves).
   *
   * #731: except ahead of an urgent waiter that has already waited through a normal holder's turn: that one is served
   * first. So an urgent waiter waits out at most ONE normal holder (the one running when it joined, or one aged
   * waiter granted while it waited), never a chain of aged ones. Normal work still never starves: once the oldest
   * normal waiter has aged, no other normal holder runs before it, so the urgent waiters that waited through the last
   * normal holder are a fixed set (with max 1 and one waiter per caller, at most one per caller) that only shrinks;
   * urgent waiters that join after it have waited behind urgent holders only, and aging passes them.
   */
  agingMs?: number;
  /** The clock aging reads (tests). */
  now?: () => number;
  /**
   * #716: the most wait time `pause()` may give back to one waiter in total (default: none — a pause then only
   * defers the expiry it would have had). See `pause()`.
   */
  pauseCreditMs?: number;
}

export class OpSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  /** #716: waiters that asked for priority (`acquire(…, { urgent: true })`). Empty unless a caller uses it. */
  private readonly urgent: Waiter[] = [];
  private readonly now: () => number;
  /** #716: when the current pause began (wall clock), or null while not paused. */
  private pausedAt: number | null = null;

  constructor(
    private readonly max: number,
    private readonly waitMs: number,
    private readonly options: OpSemaphoreOptions = {},
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error('OpSemaphore: max must be a positive integer');
    this.now = options.now ?? (() => Date.now());
  }

  /** Slots currently held (for tests and diagnostics). */
  get inUse(): number {
    return this.active;
  }

  /**
   * Resolves with a release function once a slot is held; rejects with `OpSemaphoreTimeout` after `waitMs` (the
   * constructor's, unless the caller passes what is left of its own budget — #626). `urgent` (#716) queues the caller
   * ahead of every normal waiter (subject to `agingMs`); without it the queue is plain FIFO, as before.
   */
  acquire(waitMs: number = this.waitMs, opts: { urgent?: boolean } = {}): Promise<() => void> {
    const urgent = opts.urgent === true;
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser(urgent));
    }
    const queue = urgent ? this.urgent : this.waiters;
    return new Promise((resolve, reject) => {
      const joined = Date.now();
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          this.active++;
          resolve(this.releaser(urgent));
        },
        at: this.now(),
        deadline: joined + waitMs,
        joined,
        credited: 0,
        behindNormal: false,
        expire: () => {
          clearTimeout(waiter.timer);
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          reject(new OpSemaphoreTimeout());
        },
      };
      queue.push(waiter);
      if (this.pausedAt === null) this.arm(waiter);
    });
  }

  /**
   * #716: stop every waiter's clock — the ones waiting now and any that join — until `resume()`. Used while the holder
   * of the slot is not doing anyone's work but recovering (the conversion worker reloading after a kill): that time is
   * given back to each waiter, up to `pauseCreditMs` in total per waiter, so a waiter's wait counts only the work
   * ahead of it plus at most one bounded recovery. Without it the recovery had to be folded into every waiter's wait,
   * which lengthened the worst case of a wait that saw no recovery at all. Idempotent.
   */
  pause(): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = Date.now();
    for (const w of [...this.urgent, ...this.waiters]) clearTimeout(w.timer);
  }

  /** #716: restart the waiters' clocks, each extended by the pause it sat through (capped, see `pause()`). */
  resume(): void {
    if (this.pausedAt === null) return;
    const now = Date.now();
    const pausedAt = this.pausedAt;
    this.pausedAt = null;
    const cap = this.options.pauseCreditMs ?? 0;
    for (const w of [...this.urgent, ...this.waiters]) {
      const credit = Math.min(Math.max(0, now - Math.max(pausedAt, w.joined)), Math.max(0, cap - w.credited));
      w.credited += credit;
      w.deadline += credit;
      this.arm(w);
    }
  }

  /** Start (or restart) a waiter's expiry timer for what is left of its wait; expire it now if nothing is. */
  private arm(w: Waiter): void {
    clearTimeout(w.timer);
    const ms = w.deadline - Date.now();
    if (ms <= 0) {
      w.expire();
      return;
    }
    w.timer = setTimeout(w.expire, ms);
    (w.timer as unknown as { unref?: () => void }).unref?.();
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

  /**
   * Who a freed slot goes to: an urgent waiter first, unless the oldest normal waiter has aged past `agingMs` AND the
   * oldest urgent waiter has not yet waited through a normal holder's turn (#731). Urgent waiters are FIFO, so the
   * oldest one has waited through everything a newer one has.
   */
  private next(): Waiter | undefined {
    if (this.urgent.length === 0) return this.waiters.shift();
    if (this.waiters.length === 0) return this.urgent.shift();
    const { agingMs } = this.options;
    const aged = agingMs !== undefined && this.now() - this.waiters[0].at >= agingMs;
    if (aged && !this.urgent[0].behindNormal) return this.waiters.shift();
    return this.urgent.shift();
  }

  /** `urgent`: whether the holder came through the urgent queue (#731: a normal holder's release marks the waiters). */
  private releaser(urgent: boolean): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent: a double release must never free a slot someone else holds
      released = true;
      this.active--;
      // #731: every urgent waiter still queued has now waited through this normal holder's turn.
      if (!urgent) for (const w of this.urgent) w.behindNormal = true;
      this.next()?.grant();
    };
  }
}
