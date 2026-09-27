import { Prisma, type Order, type PrismaService } from '@app/prisma';
import { OrdersService, toOrderResponse } from './orders.service.js';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ORD-1001',
    customerId: 'cus_ana',
    items: [{ sku: 'KB-01', name: 'Keyboard', quantity: 1, unitPrice: '89.90' }],
    total: new Prisma.Decimal('89.9'),
    status: 'shipped',
    createdAt: new Date('2026-08-02T14:10:00Z'),
    shippedAt: new Date('2026-08-03T09:00:00Z'),
    deliveredAt: null,
    ...overrides,
  };
}

describe('OrdersService', () => {
  const findMany = vi.fn();
  const findFirst = vi.fn();
  const service = new OrdersService({ order: { findMany, findFirst } } as unknown as PrismaService);

  beforeEach(() => {
    findMany.mockReset();
    findFirst.mockReset();
  });

  it('lists only the caller orders, newest first', async () => {
    findMany.mockResolvedValue([order()]);
    const result = await service.listForCustomer('cus_ana');
    expect(findMany).toHaveBeenCalledWith({
      where: { customerId: 'cus_ana' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result.map((o) => o.id)).toEqual(['ORD-1001']);
  });

  it('scopes a single-order lookup by both id and caller', async () => {
    findFirst.mockResolvedValue(order());
    await expect(service.findForCustomer('cus_ana', 'ORD-1001')).resolves.toMatchObject({
      id: 'ORD-1001',
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'ORD-1001', customerId: 'cus_ana' } });
  });

  it('returns null when the order is missing or owned by someone else', async () => {
    findFirst.mockResolvedValue(null);
    await expect(service.findForCustomer('cus_ben', 'ORD-1001')).resolves.toBeNull();
  });
});

describe('toOrderResponse', () => {
  it('serializes decimals with 2 places and dates as ISO strings or null', () => {
    expect(toOrderResponse(order())).toEqual({
      id: 'ORD-1001',
      customerId: 'cus_ana',
      items: [{ sku: 'KB-01', name: 'Keyboard', quantity: 1, unitPrice: '89.90' }],
      total: '89.90',
      status: 'shipped',
      createdAt: '2026-08-02T14:10:00.000Z',
      shippedAt: '2026-08-03T09:00:00.000Z',
      deliveredAt: null,
    });
  });

  it('fails loudly on malformed stored items', () => {
    expect(() => toOrderResponse(order({ items: [{ sku: 'x' }] }))).toThrow();
  });
});
