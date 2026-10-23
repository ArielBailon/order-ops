import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as customerLogin } from './login/route';
import { POST as operatorLogin } from './operator/login/route';
import { GET as evals } from './viewer/evals/route';
import { POST as login } from './viewer/login/route';
import { POST as logout } from './viewer/logout/route';
import { GET as session } from './viewer/session/route';
import { GET as summary } from './viewer/summary/route';
import { GET as traceDetail } from './viewer/traces/[id]/route';
import { GET as traces } from './viewer/traces/route';

const fetchMock = vi.fn<typeof fetch>();
const TRACE = '312f8254-84bd-4476-9e6b-fccb699c4f4e';
const viewerCookie =
  'orderops_viewer_token=jwt-vic; orderops_viewer_email=viewer@example.com';
const customerCookie = 'orderops_token=jwt-ana; orderops_email=ana@example.com';
const operatorCookie =
  'orderops_operator_token=jwt-op; orderops_operator_email=operator@example.com';

const get = (path: string, cookie = viewerCookie) =>
  new NextRequest(`http://localhost:3005${path}`, { headers: { cookie } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const upstreamUrl = () => new URL(String(fetchMock.mock.calls[0][0]));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('DEMO_PASSWORD', 'demo-secret');
  vi.stubEnv('API_URL', 'http://gateway.test');
  fetchMock.mockImplementation(async () => Response.json({ ok: true }));
});

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('viewer login', () => {
  it('logs in only as the seeded viewer and sets only the viewer cookies', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ accessToken: 'jwt-vic', expiresIn: 3600 }),
    );

    const res = await login();

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: 'viewer@example.com',
      password: 'demo-secret',
    });
    expect(res.cookies.get('orderops_viewer_token')).toMatchObject({
      value: 'jwt-vic',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 3600,
    });
    expect(res.cookies.get('orderops_token')).toBeUndefined();
    expect(res.cookies.get('orderops_operator_token')).toBeUndefined();
  });

  it('is refused by the customer login', async () => {
    const res = await customerLogin(
      new NextRequest('http://localhost:3005/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'viewer@example.com' }),
      }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is never what the operator login sends', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ accessToken: 'jwt-op', expiresIn: 3600 }),
    );

    await operatorLogin();

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).email).toBe(
      'operator@example.com',
    );
  });

  it('reports the viewer session and ends only that session on logout', async () => {
    expect(await session(get('/api/viewer/session')).json()).toEqual({
      email: 'viewer@example.com',
    });
    expect(session(get('/api/viewer/session', operatorCookie)).status).toBe(
      401,
    );

    const res = logout();

    expect(res.status).toBe(204);
    expect(res.cookies.get('orderops_viewer_token')).toMatchObject({
      value: '',
      maxAge: 0,
    });
    expect(res.cookies.get('orderops_operator_token')).toBeUndefined();
  });
});

describe('viewer routes refuse other sessions', () => {
  it.each([
    ['a customer', customerCookie],
    ['an operator', operatorCookie],
  ])(
    'return 401 for %s without calling the gateway',
    async (_label, cookie) => {
      const responses = [
        await summary(get('/api/viewer/summary', cookie)),
        await traces(get('/api/viewer/traces', cookie)),
        await traceDetail(
          get(`/api/viewer/traces/${TRACE}`, cookie),
          params(TRACE),
        ),
        await evals(get('/api/viewer/evals', cookie)),
      ];

      expect(responses.map((res) => res.status)).toEqual([401, 401, 401, 401]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('GET /api/viewer/summary', () => {
  it.each([
    ['24h', '2026-10-22T12:00:00.000Z'],
    ['7d', '2026-10-16T12:00:00.000Z'],
    ['30d', '2026-09-23T12:00:00.000Z'],
  ])('maps window %s to since %s', async (window, since) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));

    await summary(get(`/api/viewer/summary?window=${window}`));

    expect(upstreamUrl().pathname).toBe('/observability/summary');
    expect(upstreamUrl().searchParams.get('since')).toBe(since);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      authorization: 'Bearer jwt-vic',
    });
  });

  it('defaults to 7 days and rejects an unknown window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));

    await summary(get('/api/viewer/summary'));
    const bad = await summary(get('/api/viewer/summary?window=1y'));

    expect(upstreamUrl().searchParams.get('since')).toBe(
      '2026-10-16T12:00:00.000Z',
    );
    expect(bad.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/viewer/traces', () => {
  it('forwards only validated filters plus limit=50', async () => {
    await traces(
      get(`/api/viewer/traces?route=refund&status=ok&before=${TRACE}`),
    );

    expect(upstreamUrl().pathname).toBe('/observability/traces');
    expect(Object.fromEntries(upstreamUrl().searchParams)).toEqual({
      limit: '50',
      route: 'refund',
      status: 'ok',
      before: TRACE,
    });
  });

  it.each([
    'route=admin',
    'status=deleted',
    'before=not-a-uuid',
    'limit=200',
    'since=2026-01-01',
  ])('rejects %s with 400 without calling the gateway', async (query) => {
    const res = await traces(get(`/api/viewer/traces?${query}`));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/viewer/traces/[id]', () => {
  it('forwards a uuid and rejects anything else', async () => {
    await traceDetail(get(`/api/viewer/traces/${TRACE}`), params(TRACE));
    const bad = await traceDetail(
      get('/api/viewer/traces/x'),
      params('../summary'),
    );

    expect(upstreamUrl().pathname).toBe(`/observability/traces/${TRACE}`);
    expect(bad.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes a 404 through with a fixed message', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: 'x' }, { status: 404 }),
    );

    const res = await traceDetail(
      get(`/api/viewer/traces/${TRACE}`),
      params(TRACE),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'That trace does not exist.' });
  });
});

describe('gateway failures', () => {
  it('clears only the viewer cookies on a gateway 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const res = await evals(get('/api/viewer/evals'));

    expect(res.status).toBe(401);
    expect(res.cookies.get('orderops_viewer_token')).toMatchObject({
      value: '',
      maxAge: 0,
    });
    expect(res.cookies.get('orderops_token')).toBeUndefined();
  });

  it('passes a 403 through with a fixed message and maps unreachable to 502', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    const forbidden = await evals(get('/api/viewer/evals'));
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const down = await evals(get('/api/viewer/evals'));

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      message: 'This account cannot read observability data.',
    });
    expect(down.status).toBe(502);
  });

  it('forwards the evals request to the fixed path', async () => {
    await evals(get('/api/viewer/evals'));

    expect(upstreamUrl().pathname).toBe('/observability/evals/latest');
  });
});
