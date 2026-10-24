import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimits } from '@/lib/rate-limit';
import { POST as chat } from './chat/route';
import { POST as login } from './login/route';
import { POST as operatorLogin } from './operator/login/route';
import { GET as listRefunds } from './operator/refunds/route';
import { GET as refundStatus } from './refunds/[id]/route';
import { POST as viewerLogin } from './viewer/login/route';

const fetchMock = vi.fn<typeof fetch>();
const customerCookie = 'orderops_token=jwt-ana; orderops_email=ana@example.com';
const operatorCookie =
  'orderops_operator_token=jwt-op; orderops_operator_email=operator@example.com';

function from(
  ip: string,
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): NextRequest {
  return new NextRequest(`http://localhost:3005${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-real-ip': ip,
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const chatFrom = (ip: string) =>
  from(ip, '/api/chat', {
    method: 'POST',
    cookie: customerCookie,
    body: { message: 'where is my order?' },
  });

async function expectLimited(res: Response) {
  expect(res.status).toBe(429);
  const seconds = Number(res.headers.get('retry-after'));
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(seconds).toBeLessThanOrEqual(60);
  expect(await res.json()).toEqual({
    message: `Too many requests. Try again in ${seconds} seconds.`,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('DEMO_PASSWORD', 'demo-secret');
  vi.stubEnv('API_URL', 'http://gateway.test');
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRateLimits();
});

describe('console rate limits per IP', () => {
  it('shares 10 logins a minute across the customer, operator and viewer logins', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ accessToken: 'jwt', expiresIn: 3600 }),
    );
    for (let i = 0; i < 4; i++)
      expect(
        (
          await login(
            from('203.0.113.7', '/api/login', {
              method: 'POST',
              body: { email: 'ana@example.com' },
            }),
          )
        ).status,
      ).toBe(200);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await operatorLogin(
            from('203.0.113.7', '/api/operator/login', { method: 'POST' }),
          )
        ).status,
      ).toBe(200);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await viewerLogin(
            from('203.0.113.7', '/api/viewer/login', { method: 'POST' }),
          )
        ).status,
      ).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(10);

    await expectLimited(
      await operatorLogin(
        from('203.0.113.7', '/api/operator/login', { method: 'POST' }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(10);

    // Another client still gets in.
    expect(
      (
        await viewerLogin(
          from('198.51.100.1', '/api/viewer/login', { method: 'POST' }),
        )
      ).status,
    ).toBe(200);
  });

  it('refuses the 11th chat message from one IP without calling the gateway', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('event: final\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    for (let i = 0; i < 10; i++)
      expect((await chat(chatFrom('203.0.113.7'))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(10);

    await expectLimited(await chat(chatFrom('203.0.113.7')));
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect((await chat(chatFrom('198.51.100.1'))).status).toBe(200);
  });

  it('counts a refused body against the chat limit too', async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await chat(
            from('203.0.113.7', '/api/chat', {
              method: 'POST',
              cookie: customerCookie,
              body: { message: '' },
            }),
          )
        ).status,
      ).toBe(400);
    await expectLimited(await chat(chatFrom('203.0.113.7')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares 60 refund requests a minute across the customer and operator routes', async () => {
    fetchMock.mockImplementation(async () => Response.json({ refunds: [] }));
    const params = { params: Promise.resolve({ id: 'ref_1' }) };
    for (let i = 0; i < 30; i++)
      expect(
        (
          await refundStatus(
            from('203.0.113.7', '/api/refunds/ref_1', {
              cookie: customerCookie,
            }),
            params,
          )
        ).status,
      ).toBe(200);
    for (let i = 0; i < 30; i++)
      expect(
        (
          await listRefunds(
            from('203.0.113.7', '/api/operator/refunds', {
              cookie: operatorCookie,
            }),
          )
        ).status,
      ).toBe(200);

    await expectLimited(
      await refundStatus(
        from('203.0.113.7', '/api/refunds/ref_1', { cookie: customerCookie }),
        params,
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });

  it('keeps the groups apart: logins do not use up chat', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ accessToken: 'jwt', expiresIn: 3600 }),
    );
    for (let i = 0; i < 11; i++)
      await operatorLogin(
        from('203.0.113.7', '/api/operator/login', { method: 'POST' }),
      );
    fetchMock.mockImplementation(
      async () =>
        new Response('event: final\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect((await chat(chatFrom('203.0.113.7'))).status).toBe(200);
  });
});

describe('gateway chat limit', () => {
  it('maps a gateway 429 to the console 429 with its Retry-After', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          statusCode: 429,
          message: 'Too many chat messages. Try again in 17 seconds.',
        },
        { status: 429, headers: { 'retry-after': '17' } },
      ),
    );
    const res = await chat(chatFrom('203.0.113.7'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect(await res.json()).toEqual({
      message: 'Too many requests. Try again in 17 seconds.',
    });
  });

  it('waits a full minute when the gateway sends no usable Retry-After', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    const res = await chat(chatFrom('203.0.113.7'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});
