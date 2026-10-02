import type { PrismaService } from '@app/prisma';
import { PrismaRefundStore } from './refund.store.js';

describe('PrismaRefundStore', () => {
  const refundRequest = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  };
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

  it('writes the thread key on create', async () => {
    await store.create({ ...pending, threadKey: 'cus_ana:thread-1' });
    expect(refundRequest.create.mock.calls[0][0].data.threadKey).toBe(
      'cus_ana:thread-1',
    );
  });

  describe('decide', () => {
    const row = (overrides = {}) => ({
      id: 'ref_1',
      orderId: 'ord_1',
      customerId: 'cus_ana',
      amount: { toFixed: () => '89.90' },
      status: 'pending_approval',
      threadKey: 'cus_ana:thread-1',
      ...overrides,
    });

    beforeEach(() => {
      refundRequest.updateMany.mockReset();
      refundRequest.findUnique.mockReset();
    });

    it('decides a pending request in one conditional update that excludes the operator own requests', async () => {
      refundRequest.updateMany.mockResolvedValue({ count: 1 });
      refundRequest.findUnique.mockResolvedValue(row({ status: 'approved' }));

      const result = await store.decide({
        id: 'ref_1',
        decision: 'approved',
        operatorId: 'op_sam',
      });

      expect(refundRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ref_1',
          status: 'pending_approval',
          customerId: { not: 'op_sam' },
        },
        data: { status: 'approved', decidedBy: 'op_sam' },
      });
      expect(result).toEqual({
        ok: true,
        refund: {
          id: 'ref_1',
          orderId: 'ord_1',
          customerId: 'cus_ana',
          amount: '89.90',
          status: 'approved',
          threadKey: 'cus_ana:thread-1',
        },
      });
    });

    it('records a rejection', async () => {
      refundRequest.updateMany.mockResolvedValue({ count: 1 });
      refundRequest.findUnique.mockResolvedValue(row({ status: 'rejected' }));
      const result = await store.decide({
        id: 'ref_1',
        decision: 'rejected',
        operatorId: 'op_sam',
      });
      expect(refundRequest.updateMany.mock.calls[0][0].data).toEqual({
        status: 'rejected',
        decidedBy: 'op_sam',
      });
      expect(result).toMatchObject({ ok: true, refund: { status: 'rejected' } });
    });

    it('reports an unknown id as not_found', async () => {
      refundRequest.updateMany.mockResolvedValue({ count: 0 });
      refundRequest.findUnique.mockResolvedValue(null);
      await expect(
        store.decide({ id: 'nope', decision: 'approved', operatorId: 'op_sam' }),
      ).resolves.toEqual({ ok: false, code: 'not_found' });
    });

    it.each(['approved', 'rejected', 'auto_rejected'])(
      'reports an already %s request as not_pending',
      async (status) => {
        refundRequest.updateMany.mockResolvedValue({ count: 0 });
        refundRequest.findUnique.mockResolvedValue(row({ status }));
        await expect(
          store.decide({
            id: 'ref_1',
            decision: 'approved',
            operatorId: 'op_sam',
          }),
        ).resolves.toEqual({ ok: false, code: 'not_pending' });
      },
    );

    it('reports a still pending request that was not updated as own_request', async () => {
      refundRequest.updateMany.mockResolvedValue({ count: 0 });
      refundRequest.findUnique.mockResolvedValue(
        row({ customerId: 'op_sam' }),
      );
      await expect(
        store.decide({ id: 'ref_1', decision: 'approved', operatorId: 'op_sam' }),
      ).resolves.toEqual({ ok: false, code: 'own_request' });
    });
  });

  describe('listPending', () => {
    it('returns only pending requests, oldest first, with two-decimal amounts and ISO dates', async () => {
      refundRequest.findMany.mockResolvedValue([
        {
          id: 'ref_1',
          orderId: 'ord_1',
          customerId: 'cus_ana',
          amount: { toFixed: () => '89.90' },
          reason: 'Arrived broken',
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
      ]);

      const result = await store.listPending();

      expect(refundRequest.findMany.mock.calls[0][0]).toMatchObject({
        where: { status: 'pending_approval' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toEqual([
        {
          id: 'ref_1',
          orderId: 'ord_1',
          customerId: 'cus_ana',
          amount: '89.90',
          reason: 'Arrived broken',
          createdAt: '2026-10-01T10:00:00.000Z',
        },
      ]);
    });
  });
});
