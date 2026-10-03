import type { Order } from '../chat/chat.schemas.js';

/** Fixed clock for every eval run, so the 30-day refund window is stable. */
export const NOW = new Date('2026-10-03T12:00:00.000Z');

export const CUSTOMER_IDS = {
  ana: 'cus_ana',
  ben: 'cus_ben',
  cora: 'cus_cora',
} as const;

export type EvalCustomer = keyof typeof CUSTOMER_IDS;

const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

type OrderState =
  | { status: 'pending' | 'processing' }
  | { status: 'shipped'; shippedDaysAgo: number }
  | { status: 'delivered'; deliveredDaysAgo: number };

const order = (
  id: string,
  customer: EvalCustomer,
  name: string,
  total: string,
  state: OrderState,
): Order => {
  const createdDaysAgo =
    state.status === 'delivered'
      ? state.deliveredDaysAgo + 6
      : state.status === 'shipped'
        ? state.shippedDaysAgo + 2
        : 1;
  return {
    id,
    customerId: CUSTOMER_IDS[customer],
    items: [
      { sku: `SKU-${id.slice(-4)}`, name, quantity: 1, unitPrice: total },
    ],
    total,
    status: state.status,
    createdAt: daysAgo(createdDaysAgo),
    shippedAt:
      state.status === 'shipped'
        ? daysAgo(state.shippedDaysAgo)
        : state.status === 'delivered'
          ? daysAgo(state.deliveredDaysAgo + 4)
          : null,
    deliveredAt:
      state.status === 'delivered' ? daysAgo(state.deliveredDaysAgo) : null,
  };
};

/** Delivered inside and outside the 30-day window, shipped, pending and processing. */
export const ORDERS: readonly Order[] = [
  order('ORD-1001', 'ana', 'Wireless Headphones', '89.90', {
    status: 'delivered',
    deliveredDaysAgo: 10,
  }),
  order('ORD-1002', 'ana', 'Electric Kettle', '39.90', {
    status: 'shipped',
    shippedDaysAgo: 1,
  }),
  order('ORD-1003', 'ana', 'Desk Lamp', '59.00', {
    status: 'delivered',
    deliveredDaysAgo: 45,
  }),
  order('ORD-2001', 'ben', 'Mechanical Keyboard', '120.00', {
    status: 'delivered',
    deliveredDaysAgo: 5,
  }),
  order('ORD-2002', 'ben', 'USB-C Cable', '24.50', { status: 'pending' }),
  order('ORD-2003', 'ben', 'Water Bottle', '35.00', {
    status: 'delivered',
    deliveredDaysAgo: 20,
  }),
  order('ORD-2004', 'ben', 'Phone Stand', '18.00', { status: 'processing' }),
  order('ORD-3001', 'cora', 'Espresso Machine', '249.00', {
    status: 'delivered',
    deliveredDaysAgo: 3,
  }),
  order('ORD-3002', 'cora', 'Yoga Mat', '42.00', {
    status: 'shipped',
    shippedDaysAgo: 2,
  }),
];
