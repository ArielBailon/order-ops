import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../libs/prisma/src/generated/client.js';
import { hashPassword } from '../libs/auth/src/password.js';

// Dev-only credentials shared by every seed customer; documented in AGENTS.md.
const SEED_PASSWORD = 'orderops-dev-password';

const customers = [
  { id: 'cus_ana', name: 'Ana Torres', email: 'ana@example.com', tier: 'premium', role: 'customer' },
  { id: 'cus_ben', name: 'Ben Carter', email: 'ben@example.com', tier: 'standard', role: 'customer' },
  { id: 'cus_cora', name: 'Cora Diaz', email: 'cora@example.com', tier: 'standard', role: 'customer' },
  { id: 'op_sam', name: 'Sam Operator', email: 'operator@example.com', tier: 'standard', role: 'operator' },
] as const;

const orders = [
  {
    id: 'ORD-1001',
    customerId: 'cus_ana',
    items: [{ sku: 'KB-01', name: 'Mechanical keyboard', quantity: 1, unitPrice: '89.90' }],
    total: '89.90',
    status: 'delivered',
    createdAt: '2026-08-02T14:10:00Z',
    shippedAt: '2026-08-03T09:00:00Z',
    deliveredAt: '2026-08-06T16:30:00Z',
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
    createdAt: '2026-09-18T10:00:00Z',
    shippedAt: '2026-09-20T08:45:00Z',
    deliveredAt: null,
  },
  {
    id: 'ORD-1003',
    customerId: 'cus_ana',
    items: [{ sku: 'HD-04', name: 'Noise-cancelling headphones', quantity: 1, unitPrice: '199.00' }],
    total: '199.00',
    status: 'processing',
    createdAt: '2026-09-24T19:20:00Z',
    shippedAt: null,
    deliveredAt: null,
  },
  {
    id: 'ORD-2001',
    customerId: 'cus_ben',
    items: [{ sku: 'MN-05', name: '27-inch monitor', quantity: 1, unitPrice: '249.99' }],
    total: '249.99',
    status: 'pending',
    createdAt: '2026-09-25T12:00:00Z',
    shippedAt: null,
    deliveredAt: null,
  },
  {
    id: 'ORD-2002',
    customerId: 'cus_ben',
    items: [{ sku: 'CB-06', name: 'USB-C cable', quantity: 3, unitPrice: '9.99' }],
    total: '29.97',
    status: 'cancelled',
    createdAt: '2026-07-11T08:30:00Z',
    shippedAt: null,
    deliveredAt: null,
  },
  {
    id: 'ORD-2003',
    customerId: 'cus_ben',
    items: [{ sku: 'LP-07', name: 'Laptop stand', quantity: 1, unitPrice: '45.00' }],
    total: '45.00',
    status: 'delivered',
    createdAt: '2026-06-01T15:00:00Z',
    shippedAt: '2026-06-02T10:00:00Z',
    deliveredAt: '2026-06-05T13:15:00Z',
  },
  {
    id: 'ORD-2004',
    customerId: 'cus_ben',
    items: [{ sku: 'WC-08', name: 'Webcam', quantity: 1, unitPrice: '74.00' }],
    total: '74.00',
    status: 'shipped',
    createdAt: '2026-09-21T09:40:00Z',
    shippedAt: '2026-09-23T07:30:00Z',
    deliveredAt: null,
  },
] as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    for (const customer of customers) {
      const data = { ...customer, passwordHash: await hashPassword(SEED_PASSWORD) };
      await prisma.customer.upsert({ where: { id: customer.id }, create: data, update: data });
    }
    for (const order of orders) {
      const data = { ...order, items: [...order.items] };
      await prisma.order.upsert({ where: { id: order.id }, create: data, update: data });
    }
    console.log(`Seeded ${customers.length} customers and ${orders.length} orders`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
