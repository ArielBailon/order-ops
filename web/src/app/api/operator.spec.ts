import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimits } from '@/lib/rate-limit';
import { POST as customerLogin } from './login/route';
import { POST as login } from './operator/login/route';
import { POST as logout } from './operator/logout/route';
import { GET as listRefunds } from './operator/refunds/route';
import { POST as decide } from './operator/refunds/[id]/[decision]/route';
import { GET as session } from './operator/session/route';
import { GET as refundStatus } from './refunds/[id]/route';

const fetchMock = vi.fn<typeof fetch>();
const operatorCookie =
  'orderops_operator_token=jwt-op; orderops_operator_email=operator@example.com';
const customerCookie = 'orderops_token=jwt-ana; orderops_email=ana@example.com';

function request(path: string, method = 'GET', cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3005${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const pending = [
  {
    id: 'ref_1',
    orderId: 'ord_1001',
    customerId: 'cus_ana',
    amount: '89.90',
    reason: 'Arrived broken',
    createdAt: '2026-10-20T10:00:00.000Z',
  },
];

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

describe('operator login', () => {
  it('logs in only as the seeded operator and sets the operator cookies', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ accessToken: 'jwt-op', expiresIn: 3600 }),
    );

    const res = await login(request('/api/operator/login', 'POST'));

    expect(res.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: 'operator@example.com',
      password: 'demo-secret',
    });
    expect(res.cookies.get('orderops_operator_token')).toMatchObject({
      value: 'jwt-op',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 3600,
    });
    expect(res.cookies.get('orderops_token')).toBeUndefined();
  });

  it('is still refused by the customer login', async () => {
    const res = await customerLogin(
      new NextRequest('http://localhost:3005/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'operator@example.com' }),
      }),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the operator session and ends only that session on logout', async () => {
    expect(
      await session(
        request('/api/operator/session', 'GET', operatorCookie),
      ).json(),
    ).toEqual({
      email: 'operator@example.com',
    });
    expect(
      session(request('/api/operator/session', 'GET', customerCookie)).status,
    ).toBe(401);

    const res = logout();

    expect(res.status).toBe(204);
    expect(res.cookies.get('orderops_operator_token')).toMatchObject({
      value: '',
      maxAge: 0,
    });
    expect(res.cookies.get('orderops_token')).toBeUndefined();
  });
});

describe('operator refund routes', () => {
  it('refuse a customer session without calling the gateway', async () => {
    const list = await listRefunds(
      request('/api/operator/refunds', 'GET', customerCookie),
    );
    const decision = await decide(
      request('/api/operator/refunds/ref_1/approve', 'POST', customerCookie),
      params({ id: 'ref_1', decision: 'approve' }),
    );

    expect(list.status).toBe(401);
    expect(decision.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists pending refunds with the operator token', async () => {
    fetchMock.mockResolvedValue(Response.json({ refunds: pending }));

    const res = await listRefunds(
      request('/api/operator/refunds', 'GET', operatorCookie),
    );

    expect(await res.json()).toEqual({ refunds: pending });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test/refunds/pending');
    expect(init?.headers).toEqual({ authorization: 'Bearer jwt-op' });
  });

  it.each(['approve', 'reject'])(
    'forwards %s to the exact gateway path',
    async (decision) => {
      fetchMock.mockResolvedValue(
        Response.json({ id: 'ref_1', status: 'approved', decidedBy: 'op_sam' }),
      );

      const res = await decide(
        request(
          `/api/operator/refunds/ref_1/${decision}`,
          'POST',
          operatorCookie,
        ),
        params({ id: 'ref_1', decision }),
      );

      expect(res.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`http://gateway.test/refunds/ref_1/${decision}`);
      expect(init?.method).toBe('POST');
    },
  );

  it.each([
    [{ id: 'ref_1', decision: 'delete' }],
    [{ id: '../pending', decision: 'approve' }],
    [{ id: 'ref 1', decision: 'approve' }],
    [{ id: 'x'.repeat(101), decision: 'approve' }],
  ])('rejects %j with 400 without calling the gateway', async (value) => {
    const res = await decide(
      request('/api/operator/refunds/x/y', 'POST', operatorCookie),
      params(value),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409])(
    'passes a gateway %i through with a fixed message',
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({ message: 'internal detail' }, { status }),
      );

      const res = await decide(
        request('/api/operator/refunds/ref_1/approve', 'POST', operatorCookie),
        params({ id: 'ref_1', decision: 'approve' }),
      );

      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).toEqual({ message: expect.any(String) });
      expect(body.message).not.toBe('internal detail');
    },
  );

  it('clears only the operator cookies on a gateway 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const res = await listRefunds(
      request('/api/operator/refunds', 'GET', operatorCookie),
    );

    expect(res.status).toBe(401);
    expect(res.cookies.get('orderops_operator_token')).toMatchObject({
      value: '',
      maxAge: 0,
    });
    expect(res.cookies.get('orderops_token')).toBeUndefined();
  });

  it('returns 502 when the gateway is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const res = await listRefunds(
      request('/api/operator/refunds', 'GET', operatorCookie),
    );

    expect(res.status).toBe(502);
  });
});

describe('customer refund status', () => {
  it('forwards with the customer token, never the operator token', async () => {
    const body = {
      id: 'ref_1',
      orderId: 'ord_1001',
      amount: '89.90',
      status: 'approved',
      message: 'Update on refund request ref_1: approved.',
    };
    fetchMock.mockResolvedValue(Response.json(body));

    const res = await refundStatus(
      request(
        '/api/refunds/ref_1',
        'GET',
        `${customerCookie}; ${operatorCookie}`,
      ),
      params({ id: 'ref_1' }),
    );

    expect(await res.json()).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test/refunds/mine/ref_1');
    expect(init?.headers).toEqual({ authorization: 'Bearer jwt-ana' });
  });

  it('returns 401 with only an operator session', async () => {
    const res = await refundStatus(
      request('/api/refunds/ref_1', 'GET', operatorCookie),
      params({ id: 'ref_1' }),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, 404],
    [401, 401],
  ])('maps a gateway %i to %i', async (upstream, expected) => {
    fetchMock.mockResolvedValue(new Response(null, { status: upstream }));

    const res = await refundStatus(
      request('/api/refunds/ref_1', 'GET', customerCookie),
      params({ id: 'ref_1' }),
    );

    expect(res.status).toBe(expected);
  });

  it('rejects a malformed id and maps an unreachable gateway to 502', async () => {
    const bad = await refundStatus(
      request('/api/refunds/x', 'GET', customerCookie),
      params({ id: 'ref/1' }),
    );
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const down = await refundStatus(
      request('/api/refunds/ref_1', 'GET', customerCookie),
      params({ id: 'ref_1' }),
    );

    expect(bad.status).toBe(400);
    expect(down.status).toBe(502);
  });
});
