import { NextRequest, type NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimits } from '@/lib/rate-limit';
import { POST as chat } from './chat/route';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';
import { GET as session } from './session/route';

const THREAD = '3e833860-4d78-4152-a1a8-64e32bebbc11';
const fetchMock = vi.fn<typeof fetch>();

function jsonRequest(
  path: string,
  body: unknown,
  cookies: Record<string, string> = {},
): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return new NextRequest(`http://localhost:3005${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const loggedIn = { orderops_token: 'jwt-ana', orderops_email: 'ana@example.com' };

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

describe('POST /api/login', () => {
  it.each(['operator@example.com', 'viewer@example.com', 'eve@example.com', 42])(
    'rejects %s without calling the gateway',
    async (email) => {
      const res = await login(jsonRequest('/api/login', { email }));

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.cookies.get('orderops_token')).toBeUndefined();
    },
  );

  it('logs a demo customer in and keeps the token in an httpOnly cookie', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ accessToken: 'jwt-ana', tokenType: 'Bearer', expiresIn: 3600 }),
    );

    const res = await login(jsonRequest('/api/login', { email: 'ana@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'ana@example.com' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test/auth/login');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'ana@example.com',
      password: 'demo-secret',
    });
    expect(res.cookies.get('orderops_token')).toMatchObject({
      value: 'jwt-ana',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
      secure: false,
    });
    expect(res.cookies.get('orderops_email')).toMatchObject({
      value: 'ana@example.com',
      httpOnly: true,
    });
  });

  it('marks the cookies Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    fetchMock.mockResolvedValue(
      Response.json({ accessToken: 'jwt-ana', expiresIn: 3600 }),
    );

    const res = await login(jsonRequest('/api/login', { email: 'ana@example.com' }));

    expect(res.cookies.get('orderops_token')?.secure).toBe(true);
  });

  it('maps a gateway 401 to 401 and sets no cookie', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const res = await login(jsonRequest('/api/login', { email: 'ben@example.com' }));

    expect(res.status).toBe(401);
    expect(res.cookies.get('orderops_token')).toBeUndefined();
  });

  it('returns 502 when the gateway is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const res = await login(jsonRequest('/api/login', { email: 'cora@example.com' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ message: expect.any(String) });
  });

  it('fails with a 500 that names no secret when DEMO_PASSWORD is missing', async () => {
    vi.stubEnv('DEMO_PASSWORD', '');

    const res = await login(jsonRequest('/api/login', { email: 'ana@example.com' }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('DEMO_PASSWORD');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const res = await login(jsonRequest('/api/login', 'email=ana'));

    expect(res.status).toBe(400);
  });
});

describe('GET /api/session and POST /api/logout', () => {
  it('returns the email of a live session and 401 without one', async () => {
    const live = session(
      new NextRequest('http://localhost:3005/api/session', {
        headers: { cookie: 'orderops_token=jwt-ana; orderops_email=ana@example.com' },
      }),
    );
    const none = session(new NextRequest('http://localhost:3005/api/session'));

    expect(await live.json()).toEqual({ email: 'ana@example.com' });
    expect(none.status).toBe(401);
  });

  it('expires both cookies on logout', () => {
    const res = logout();

    expect(res.status).toBe(204);
    expect(res.cookies.get('orderops_token')).toMatchObject({ value: '', maxAge: 0 });
    expect(res.cookies.get('orderops_email')).toMatchObject({ value: '', maxAge: 0 });
  });
});

describe('POST /api/chat', () => {
  const sse = 'event: token\ndata: {"text":"Hi"}\n\nevent: final\ndata: {}\n\n';

  it('returns 401 without a session and does not call the gateway', async () => {
    const res = await chat(jsonRequest('/api/chat', { message: 'hi' }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only message and threadId with the bearer token and streams the reply', async () => {
    fetchMock.mockResolvedValue(
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );

    const res = await chat(
      jsonRequest(
        '/api/chat',
        { message: 'where is my order?', threadId: THREAD, token: 'forged', role: 'operator' },
        loggedIn,
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe(sse);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test/chat');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer jwt-ana' });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: 'where is my order?',
      threadId: THREAD,
    });
  });

  it.each([
    [{ message: '' }],
    [{ message: '   ' }],
    [{ message: 'x'.repeat(2001) }],
    [{ message: 'hi', threadId: 'not-a-uuid' }],
    [{ text: 'hi' }],
  ])('rejects %j with 400 without calling the gateway', async (body) => {
    const res = await chat(jsonRequest('/api/chat', body, loggedIn));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the session when the gateway answers 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const res = await chat(jsonRequest('/api/chat', { message: 'hi' }, loggedIn));

    expect(res.status).toBe(401);
    // The 401 is built as a NextResponse; the route's type is the plain Response it streams.
    expect((res as NextResponse).cookies.get('orderops_token')).toMatchObject({
      value: '',
      maxAge: 0,
    });
  });

  it('returns 502 when the gateway is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const res = await chat(jsonRequest('/api/chat', { message: 'hi' }, loggedIn));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ message: expect.any(String) });
  });

  it('aborts the gateway request when the browser request is aborted', async () => {
    let upstreamSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream(), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const controller = new AbortController();
    const request = new NextRequest('http://localhost:3005/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'orderops_token=jwt-ana',
      },
      body: JSON.stringify({ message: 'hi' }),
      signal: controller.signal,
    });

    await chat(request);
    controller.abort();

    expect(upstreamSignal?.aborted).toBe(true);
  });
});
