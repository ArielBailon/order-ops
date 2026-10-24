import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../libs/prisma/src/generated/client.js';
import { hashPassword } from '../libs/auth/src/password.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, demoOrders } from './demo-data.js';

// Upserts the demo accounts and orders; deletes nothing (the demo reset also clears visitor data).
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    for (const account of DEMO_ACCOUNTS) {
      const data = {
        ...account,
        passwordHash: await hashPassword(DEMO_PASSWORD),
      };
      await prisma.customer.upsert({
        where: { id: account.id },
        create: data,
        update: data,
      });
    }
    const orders = demoOrders(new Date());
    for (const order of orders) {
      await prisma.order.upsert({
        where: { id: order.id },
        create: order,
        update: order,
      });
    }
    console.log(
      `Seeded ${DEMO_ACCOUNTS.length} customers and ${orders.length} orders`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
