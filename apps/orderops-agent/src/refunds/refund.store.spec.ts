import type { PrismaService } from '@app/prisma';
import { PrismaRefundStore } from './refund.store.js';

describe('PrismaRefundStore', () => {
  const refundRequest = { create: vi.fn(), findFirst: vi.fn() };
  const store = new PrismaRefundStore({
    refundRequest,
  } as unknown as PrismaService);
  const pending = {
    orderId: 'ord_1',
    customerId: 'cus_ana',
    amount: '89.90',
    reason: 'Arrived broken',
    status: 'pending_approval',
  } as const;

  beforeEach(() => {
    refundRequest.create.mockReset().mockResolvedValue({});
    refundRequest.findFirst.mockReset().mockResolvedValue(null);
  });

  it('creates a pending request with a generated ref_ id and no decider', async () => {
    const result = await store.create(pending);

    expect(result).toEqual({
      ok: true,
      refund: {
        id: expect.stringMatching(/^ref_[0-9a-f-]{36}$/),
        status: 'pending_approval',
      },
    });
    expect(refundRequest.create.mock.calls[0][0].data).toMatchObject({
      orderId: 'ord_1',
      customerId: 'cus_ana',
      amount: '89.90',
      status: 'pending_approval',
      decidedBy: null,
      decisionReason: null,
    });
  });

  it('stores an auto_rejected request decided by the system with its rule code', async () => {
    await store.create({
      ...pending,
      status: 'auto_rejected',
      decisionReason: 'window_expired',
    });

    expect(refundRequest.create.mock.calls[0][0].data).toMatchObject({
      status: 'auto_rejected',
      decidedBy: 'system',
      decisionReason: 'window_expired',
    });
  });

  const uniqueViolation = () =>
    Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  it('maps a unique violation to open_request_exists when an open request exists', async () => {
    refundRequest.create.mockRejectedValue(uniqueViolation());
    refundRequest.findFirst.mockResolvedValue({ id: 'ref_existing' });

    const result = await store.create(pending);

    expect(result).toEqual({
      ok: false,
      code: 'open_request_exists',
      existing: { id: 'ref_existing', status: 'pending_approval' },
    });
    expect(refundRequest.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'ord_1', status: 'pending_approval' },
      select: { id: true },
    });
  });

  it('rethrows an insert failure that is not a unique violation even if a request is open', async () => {
    refundRequest.create.mockRejectedValue(new Error('db down'));
    refundRequest.findFirst.mockResolvedValue({ id: 'ref_existing' });

    await expect(store.create(pending)).rejects.toThrow('db down');
    expect(refundRequest.findFirst).not.toHaveBeenCalled();
  });

  it('rethrows the original error when the duplicate lookup also fails', async () => {
    const original = uniqueViolation();
    refundRequest.create.mockRejectedValue(original);
    refundRequest.findFirst.mockRejectedValue(new Error('lookup failed'));

    await expect(store.create(pending)).rejects.toBe(original);
  });

  it('rethrows a unique violation when no open request can be found', async () => {
    const original = uniqueViolation();
    refundRequest.create.mockRejectedValue(original);

    await expect(store.create(pending)).rejects.toBe(original);
  });

  it('rethrows an insert failure that is not a duplicate open request', async () => {
    refundRequest.create.mockRejectedValue(new Error('db down'));

    await expect(store.create(pending)).rejects.toThrow('db down');
  });

  it('does not look for a duplicate when an auto_rejected insert fails', async () => {
    refundRequest.create.mockRejectedValue(new Error('db down'));

    await expect(
      store.create({
        ...pending,
        status: 'auto_rejected',
        decisionReason: 'window_expired',
      }),
    ).rejects.toThrow('db down');
    expect(refundRequest.findFirst).not.toHaveBeenCalled();
  });

  it('finds the open request of an order', async () => {
    refundRequest.findFirst.mockResolvedValue({ id: 'ref_1' });

    expect(await store.findOpenForOrder('ord_1')).toEqual({
      id: 'ref_1',
      status: 'pending_approval',
    });
  });
});
