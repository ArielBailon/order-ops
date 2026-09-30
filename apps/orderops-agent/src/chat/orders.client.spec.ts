import type { ConfigService } from '@nestjs/config';
import { ORDER_FIXTURE } from './order.fixture.js';
import { OrdersClient } from './orders.client.js';

describe('OrdersClient', () => {
  const config = {
    getOrThrow: () => 'http://orders.test',
  } as unknown as ConfigService;
  const client = new OrdersClient(config);
  const fetchMock = vi.fn();
  const signal = new AbortController().signal;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists orders with the caller token', async () => {
    fetchMock.mockResolvedValue(Response.json([ORDER_FIXTURE]));

    await expect(client.listOrders('tok', signal)).resolves.toEqual({
      ok: true,
      data: [ORDER_FIXTURE],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://orders.test/orders');
    expect(init.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('gets one order with an encoded id', async () => {
    fetchMock.mockResolvedValue(Response.json(ORDER_FIXTURE));

    await expect(client.getOrder('tok', 'ord_1001', signal)).resolves.toEqual({
      ok: true,
      data: ORDER_FIXTURE,
    });
    await client.getOrder('tok', '../customers/me', signal);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'http://orders.test/orders/..%2Fcustomers%2Fme',
    );
  });

  it('maps 404 to not_found', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: 'Order not found' }, { status: 404 }),
    );
    await expect(client.getOrder('tok', 'ord_x', signal)).resolves.toEqual({
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
    await expect(client.listOrders('tok', signal)).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('aborts the upstream fetch when the caller signal aborts', async () => {
    const abort = new AbortController();
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () =>
            reject(init.signal!.reason),
          ),
        ),
    );

    const result = client.listOrders('tok', abort.signal);
    abort.abort();

    await expect(result).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
