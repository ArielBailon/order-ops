import { ORDER_FIXTURE } from '../chat/order.fixture.js';
import type { Order } from '../chat/chat.schemas.js';
import {
  evaluateRefund,
  formatCents,
  REFUND_WINDOW_DAYS,
  type RefundCheck,
  toCents,
} from './refund-rules.js';

const DELIVERED_AT = '2026-08-06T16:30:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const delivered = (overrides: Partial<Order> = {}): Order => ({
  ...ORDER_FIXTURE,
  total: '89.90',
  status: 'delivered',
  deliveredAt: DELIVERED_AT,
  ...overrides,
});
const at = (offsetMs: number) =>
  new Date(new Date(DELIVERED_AT).getTime() + offsetMs);

const check = (overrides: Partial<RefundCheck> = {}) =>
  evaluateRefund({
    order: delivered(),
    amountCents: 8990,
    openRequestExists: false,
    now: at(DAY_MS),
    ...overrides,
  });

describe('money helpers', () => {
  it.each([
    ['89.90', 8990],
    ['5', 500],
    ['5.5', 550],
    ['0.01', 1],
    ['1234.00', 123400],
  ])('parses %s to %i cents', (money, cents) => {
    expect(toCents(money)).toBe(cents);
  });

  it.each(['', '-1.00', '1.234', 'abc', '1,50', '1e3'])(
    'rejects %j',
    (money) => {
      expect(() => toCents(money)).toThrow(RangeError);
    },
  );

  it('formats cents with two decimals', () => {
    expect([formatCents(8990), formatCents(5), formatCents(100)]).toEqual([
      '89.90',
      '0.05',
      '1.00',
    ]);
  });
});

describe('evaluateRefund', () => {
  it('accepts a delivered order inside the window for the full total', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('accepts a partial amount', () => {
    expect(check({ amountCents: 1 })).toEqual({ ok: true });
  });

  it.each(['pending', 'processing', 'shipped', 'cancelled'] as const)(
    'rejects a %s order as not_delivered',
    (status) => {
      expect(
        check({ order: delivered({ status, deliveredAt: null }) }),
      ).toEqual({ ok: false, code: 'not_delivered' });
    },
  );

  it('rejects a delivered order without a delivery date as not_delivered', () => {
    expect(check({ order: delivered({ deliveredAt: null }) })).toEqual({
      ok: false,
      code: 'not_delivered',
    });
  });

  it('accepts exactly day 30 and rejects one second later', () => {
    const edge = REFUND_WINDOW_DAYS * DAY_MS;

    expect(check({ now: at(edge) })).toEqual({ ok: true });
    expect(check({ now: at(edge + 1000) })).toEqual({
      ok: false,
      code: 'window_expired',
    });
  });

  it('accepts an amount equal to the total and rejects one cent over', () => {
    expect(check({ amountCents: 8990 })).toEqual({ ok: true });
    expect(check({ amountCents: 8991 })).toEqual({
      ok: false,
      code: 'amount_exceeds_total',
    });
  });

  it('rejects when another request is open', () => {
    expect(check({ openRequestExists: true })).toEqual({
      ok: false,
      code: 'open_request_exists',
    });
  });

  it('reports the first failing rule in the fixed order', () => {
    const late = at((REFUND_WINDOW_DAYS + 1) * DAY_MS);

    expect(
      check({
        order: delivered({ status: 'shipped' }),
        now: late,
        amountCents: 99999,
        openRequestExists: true,
      }),
    ).toEqual({ ok: false, code: 'not_delivered' });
    expect(
      check({ now: late, amountCents: 99999, openRequestExists: true }),
    ).toEqual({ ok: false, code: 'window_expired' });
    expect(check({ amountCents: 99999, openRequestExists: true })).toEqual({
      ok: false,
      code: 'amount_exceeds_total',
    });
  });
});
