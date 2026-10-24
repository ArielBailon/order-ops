import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/** Requests per client IP per minute, per group of console routes. */
export const LIMITS = { login: 10, chat: 10, refunds: 60 } as const;
export type LimitGroup = keyof typeof LIMITS;

const WINDOW_MS = 60_000;
/** Expired windows are dropped once this many keys are held, so memory stays bounded. */
const SWEEP_AT = 10_000;

export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Counts hits per key in a fixed window that starts at the key's first hit. */
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

function createLimiters(): Record<LimitGroup, FixedWindowLimiter> {
  return {
    login: new FixedWindowLimiter(LIMITS.login, WINDOW_MS),
    chat: new FixedWindowLimiter(LIMITS.chat, WINDOW_MS),
    refunds: new FixedWindowLimiter(LIMITS.refunds, WINDOW_MS),
  };
}

// Lives as long as the server instance: on Vercel each instance counts on its own (best effort).
let limiters = createLimiters();

/** Clears every count; for tests. */
export function resetRateLimits(): void {
  limiters = createLimiters();
}

/** The connecting client as Vercel reports it; `unknown` locally, where every request shares one count. */
export function clientIp(request: NextRequest): string {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')[0]
    ?.trim();
  return forwarded || 'unknown';
}

export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
    },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}

/** A 429 response when this client is over the group's limit, otherwise null (and the hit counts). */
export function rateLimited(
  request: NextRequest,
  group: LimitGroup,
): NextResponse | null {
  const result = limiters[group].hit(clientIp(request));
  return result.allowed ? null : tooManyRequests(result.retryAfterSeconds);
}
