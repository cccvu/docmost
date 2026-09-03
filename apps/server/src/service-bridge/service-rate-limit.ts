/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Minimal fixed-window per-key rate limiter (in-memory). Bounds the east-west `/api/service/*` endpoints
 * per CREDENTIAL (not per IP) as a DoS/abuse backstop. The sole caller is the trusted platform, so the
 * window is generous. One fork container per task → in-memory is sufficient (documented). `now` is
 * injectable for deterministic tests.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const cur = this.windows.get(key);
    if (!cur || now >= cur.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (cur.count >= this.limit) return false;
    cur.count += 1;
    return true;
  }
}
