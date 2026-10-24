import {
  evaluateRefund,
  toCents,
} from '../apps/orderops-agent/src/refunds/refund-rules.js';
import { demoOrders } from './demo-data.js';

const NOW = new Date('2026-10-24T04:00:00.000Z');

describe('demoOrders', () => {
  it('dates every order in days before now', () => {
    const dates = Object.fromEntries(
      demoOrders(NOW).map((o) => [
        o.id,
        [o.createdAt, o.shippedAt, o.deliveredAt].map(
          (d) => d?.toISOString() ?? null,
        ),
      ]),
    );
    expect(dates).toEqual({
      'ORD-1001': [
        '2026-10-15T04:00:00.000Z',
        '2026-10-16T04:00:00.000Z',
        '2026-10-19T04:00:00.000Z',
      ],
      'ORD-1002': [
        '2026-10-18T04:00:00.000Z',
        '2026-10-20T04:00:00.000Z',
        null,
      ],
      'ORD-1003': ['2026-10-23T04:00:00.000Z', null, null],
      'ORD-2001': ['2026-10-23T04:00:00.000Z', null, null],
      'ORD-2002': ['2026-07-11T04:00:00.000Z', null, null],
      'ORD-2003': [
        '2026-08-21T04:00:00.000Z',
        '2026-08-22T04:00:00.000Z',
        '2026-08-25T04:00:00.000Z',
      ],
      'ORD-2004': [
        '2026-10-21T04:00:00.000Z',
        '2026-10-23T04:00:00.000Z',
        null,
      ],
    });
  });

  it('keeps one delivered order inside the refund window and one outside it', () => {
    const verdict = (id: string) => {
      const order = demoOrders(NOW).find((o) => o.id === id)!;
      return evaluateRefund({
        order: {
          status: order.status,
          total: order.total,
          deliveredAt: order.deliveredAt!.toISOString(),
        },
        amountCents: toCents(order.total),
        alreadyRefunded: false,
        openRequestExists: false,
        now: NOW,
      });
    };
    expect(verdict('ORD-1001')).toEqual({ ok: true });
    expect(verdict('ORD-2003')).toEqual({ ok: false, code: 'window_expired' });
  });

  it('returns fresh item arrays on every call', () => {
    const [a] = demoOrders(NOW);
    const [b] = demoOrders(NOW);
    expect(a.items).not.toBe(b.items);
    expect(a.items).toEqual(b.items);
  });
});
