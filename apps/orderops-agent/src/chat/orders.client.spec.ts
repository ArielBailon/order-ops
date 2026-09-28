import type { ConfigService } from '@nestjs/config';
import { ORDER_FIXTURE } from './order.fixture.js';
import { OrdersClient } from './orders.client.js';

describe('OrdersClient', () => {
  const config = {
    getOrThrow: () => 'http://orders.test',
  } as unknown as ConfigService;
  const client = new OrdersClient(config);
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists orders with the caller token', async () => {
    fetchMock.mockResolvedValue(Response.json([ORDER_FIXTURE]));

    await expect(client.listOrders('tok')).resolves.toEqual({
      ok: true,
      data: [ORDER_FIXTURE],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://orders.test/orders');
    expect(init.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('gets one order with an encoded id', async () => {
    fetchMock.mockResolvedValue(Response.json(ORDER_FIXTURE));

    await expect(client.getOrder('tok', 'ord_1001')).resolves.toEqual({
      ok: true,
      data: ORDER_FIXTURE,
    });
    await client.getOrder('tok', '../customers/me');
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'http://orders.test/orders/..%2Fcustomers%2Fme',
    );
  });

  it('maps 404 to not_found', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: 'Order not found' }, { status: 404 }),
    );
    await expect(client.getOrder('tok', 'ord_x')).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it.each([
    [
      'unreachable',
      () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
    ],
    [
      'timeout',
      () =>
        fetchMock.mockRejectedValue(
          new DOMException('timed out', 'TimeoutError'),
        ),
    ],
    [
      '401',
      () => fetchMock.mockResolvedValue(Response.json({}, { status: 401 })),
    ],
    [
      '5xx',
      () => fetchMock.mockResolvedValue(new Response('boom', { status: 500 })),
    ],
    [
      'malformed body',
      () => fetchMock.mockResolvedValue(Response.json([{ id: 1 }])),
    ],
    [
      'non-JSON body',
      () => fetchMock.mockResolvedValue(new Response('<html>')),
    ],
  ])('maps %s to unavailable', async (_label, arrange) => {
    arrange();
    await expect(client.listOrders('tok')).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });
});
