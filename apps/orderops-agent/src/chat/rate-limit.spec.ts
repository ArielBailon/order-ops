import { CHAT_LIMIT_PER_MINUTE, FixedWindowLimiter } from './rate-limit.js';

describe('FixedWindowLimiter', () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = Date.UTC(2026, 9, 24, 12, 0, 0);
  });

  it('allows the limit and refuses the next hit with the seconds left in the window', () => {
    const limiter = new FixedWindowLimiter(
      CHAT_LIMIT_PER_MINUTE,
      60_000,
      clock,
    );
    for (let i = 0; i < 30; i++)
      expect(limiter.hit('cus_ana')).toEqual({ allowed: true });
    now += 20_500;
    expect(limiter.hit('cus_ana')).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it('reports at least one second just before the window ends', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, clock);
    limiter.hit('k');
    now += 59_999;
    expect(limiter.hit('k')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('allows again once the window has ended', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, clock);
    limiter.hit('k');
    now += 60_000;
    expect(limiter.hit('k')).toEqual({ allowed: true });
    expect(limiter.hit('k').allowed).toBe(false);
  });

  it('counts each key on its own', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, clock);
    expect(limiter.hit('cus_ana').allowed).toBe(true);
    expect(limiter.hit('cus_ben').allowed).toBe(true);
    expect(limiter.hit('cus_ana').allowed).toBe(false);
  });

  it('drops only expired windows once 10,000 keys are held', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, clock);
    for (let i = 0; i < 5_000; i++) limiter.hit(`old-${i}`);
    now += 30_000;
    for (let i = 0; i < 5_000; i++) limiter.hit(`new-${i}`);
    expect(limiter.size).toBe(10_000);
    now += 30_000;
    limiter.hit('trigger');
    // The old keys expired; the new keys are 30 s into their window and stay.
    expect(limiter.size).toBe(5_001);
    expect(limiter.hit('new-0').allowed).toBe(false);
  });
});
