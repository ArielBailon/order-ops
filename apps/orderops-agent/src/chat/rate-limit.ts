export const CHAT_RATE_LIMIT = Symbol('CHAT_RATE_LIMIT');

/** Chat messages per customer per minute. Demo visitors share the seeded customers, so this is shared too. */
export const CHAT_LIMIT_PER_MINUTE = 30;

export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Expired windows are dropped once this many keys are held, so memory stays bounded. */
const SWEEP_AT = 10_000;

/**
 * Counts hits per key in a fixed window that starts at the key's first hit. In memory: the
 * gateway runs as one container, so the count is exact; a restart resets it.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): RateLimitResult {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (!window && this.windows.size >= SWEEP_AT) this.sweep(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      const msLeft = window.start + this.windowMs - now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
      };
    }
    window.count += 1;
    return { allowed: true };
  }

  /** Number of keys held; for tests. */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows)
      if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}
