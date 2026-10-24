import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { clientIp, FixedWindowLimiter, tooManyRequests } from './rate-limit';

const at = (headers: Record<string, string>) =>
  new NextRequest('http://localhost:3005/api/chat', { headers });

describe('clientIp', () => {
  it('prefers x-real-ip, then the first x-forwarded-for entry, then unknown', () => {
    expect(
      clientIp(
        at({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }),
      ),
    ).toBe('203.0.113.7');
    expect(
      clientIp(at({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' })),
    ).toBe('198.51.100.1');
    expect(clientIp(at({}))).toBe('unknown');
  });
});

describe('FixedWindowLimiter', () => {
  it('refuses past the limit until the window ends, per key', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter(2, 60_000, () => now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    now += 15_200;
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 45 });
    expect(limiter.hit('b').allowed).toBe(true);
    now += 44_800;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('drops only expired windows once 10,000 keys are held', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 60_000, () => now);
    for (let i = 0; i < 10_000; i++) limiter.hit(`old-${i}`);
    now += 60_000;
    limiter.hit('fresh');
    expect(limiter.size).toBe(1);
  });
});

describe('tooManyRequests', () => {
  it('answers 429 with Retry-After and a message naming the wait', async () => {
    const res = tooManyRequests(12);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(await res.json()).toEqual({
      message: 'Too many requests. Try again in 12 seconds.',
    });
  });
});
