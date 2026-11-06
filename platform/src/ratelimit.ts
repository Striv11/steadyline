/**
 * Small in-memory fixed-window limiter for auth endpoints. State is per process, which is fine for
 * the single-instance deployment; a shared store would be needed behind several instances.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  private live(key: string) {
    const e = this.hits.get(key);
    if (e && e.resetAt > this.clock()) return e;
    this.hits.delete(key);
    return undefined;
  }

  /** Seconds to wait if `key` is over the limit, otherwise 0. Does not count a hit. */
  blockedFor(key: string): number {
    const e = this.live(key);
    return e && e.count >= this.limit ? Math.ceil((e.resetAt - this.clock()) / 1000) : 0;
  }

  /** Count one hit (a failure, a request). */
  hit(key: string): void {
    const e = this.live(key);
    if (e) e.count++;
    else {
      if (this.hits.size > 10_000) this.sweep();
      this.hits.set(key, { count: 1, resetAt: this.clock() + this.windowMs });
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep() {
    const t = this.clock();
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
