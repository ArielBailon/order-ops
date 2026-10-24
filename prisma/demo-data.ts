// The demo accounts and orders, shared by `prisma db seed` and the nightly demo reset.

// Shared by every demo account and shown on the console login screen; documented in AGENTS.md.
export const DEMO_PASSWORD = 'orderops-dev-password';

export const DEMO_ACCOUNTS = [
  {
    id: 'cus_ana',
    name: 'Ana Torres',
    email: 'ana@example.com',
    tier: 'premium',
    role: 'customer',
  },
  {
    id: 'cus_ben',
    name: 'Ben Carter',
    email: 'ben@example.com',
    tier: 'standard',
    role: 'customer',
  },
  {
    id: 'cus_cora',
    name: 'Cora Diaz',
    email: 'cora@example.com',
    tier: 'standard',
    role: 'customer',
  },
  {
    id: 'op_sam',
    name: 'Sam Operator',
    email: 'operator@example.com',
    tier: 'standard',
    role: 'operator',
  },
  {
    id: 'view_vic',
    name: 'Vic Viewer',
    email: 'viewer@example.com',
    tier: 'standard',
    role: 'viewer',
  },
] as const;

/** The customers whose refunds, memory and threads the reset clears. */
export const DEMO_CUSTOMER_IDS = ['cus_ana', 'cus_ben', 'cus_cora'] as const;

const DAY_MS = 86_400_000;

// Dates are days before `now`, so one delivered order is always inside the 30-day refund window
// (ORD-1001) and one outside it (ORD-2003), whenever the data is written.
const ORDERS = [
  {
    id: 'ORD-1001',
    customerId: 'cus_ana',
    items: [
      {
        sku: 'KB-01',
        name: 'Mechanical keyboard',
        quantity: 1,
        unitPrice: '89.90',
      },
    ],
    total: '89.90',
    status: 'delivered',
    daysAgo: { created: 9, shipped: 8, delivered: 5 },
  },
  {
    id: 'ORD-1002',
    customerId: 'cus_ana',
    items: [
      { sku: 'MS-02', name: 'Wireless mouse', quantity: 1, unitPrice: '39.50' },
      { sku: 'PD-03', name: 'Desk pad', quantity: 2, unitPrice: '15.00' },
    ],
    total: '69.50',
    status: 'shipped',
    daysAgo: { created: 6, shipped: 4, delivered: null },
  },
  {
    id: 'ORD-1003',
    customerId: 'cus_ana',
    items: [
      {
        sku: 'HD-04',
        name: 'Noise-cancelling headphones',
        quantity: 1,
        unitPrice: '199.00',
      },
    ],
    total: '199.00',
    status: 'processing',
    daysAgo: { created: 1, shipped: null, delivered: null },
  },
  {
    id: 'ORD-2001',
    customerId: 'cus_ben',
    items: [
      {
        sku: 'MN-05',
        name: '27-inch monitor',
        quantity: 1,
        unitPrice: '249.99',
      },
    ],
    total: '249.99',
    status: 'pending',
    daysAgo: { created: 1, shipped: null, delivered: null },
  },
  {
    id: 'ORD-2002',
    customerId: 'cus_ben',
    items: [
      { sku: 'CB-06', name: 'USB-C cable', quantity: 3, unitPrice: '9.99' },
    ],
    total: '29.97',
    status: 'cancelled',
    daysAgo: { created: 105, shipped: null, delivered: null },
  },
  {
    id: 'ORD-2003',
    customerId: 'cus_ben',
    items: [
      { sku: 'LP-07', name: 'Laptop stand', quantity: 1, unitPrice: '45.00' },
    ],
    total: '45.00',
    status: 'delivered',
    daysAgo: { created: 64, shipped: 63, delivered: 60 },
  },
  {
    id: 'ORD-2004',
    customerId: 'cus_ben',
    items: [{ sku: 'WC-08', name: 'Webcam', quantity: 1, unitPrice: '74.00' }],
    total: '74.00',
    status: 'shipped',
    daysAgo: { created: 3, shipped: 1, delivered: null },
  },
] as const;

const daysBefore = (now: Date, days: number | null): Date | null =>
  days === null ? null : new Date(now.getTime() - days * DAY_MS);

/** The seed orders with dates relative to `now`, ready for `prisma.order.upsert`. */
export function demoOrders(now: Date) {
  return ORDERS.map(({ daysAgo, items, ...order }) => ({
    ...order,
    items: items.map((item) => ({ ...item })),
    createdAt: daysBefore(now, daysAgo.created)!,
    shippedAt: daysBefore(now, daysAgo.shipped),
    deliveredAt: daysBefore(now, daysAgo.delivered),
  }));
}
