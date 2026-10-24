import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../libs/prisma/src/generated/client.js';
import { hashPassword } from '../libs/auth/src/password.js';
import {
  DEMO_ACCOUNTS,
  DEMO_CUSTOMER_IDS,
  DEMO_PASSWORD,
  demoOrders,
} from './demo-data.js';

/** LangGraph's checkpoint tables (created by the gateway at startup); thread ids are `<customerId>:<threadId>`. */
const CHECKPOINT_TABLES = [
  'checkpoints',
  'checkpoint_blobs',
  'checkpoint_writes',
] as const;

/** The transaction client calls the reset makes; a narrow type so specs can pass a fake. */
export interface ResetClient {
  customer: Pick<PrismaClient['customer'], 'upsert'>;
  order: Pick<PrismaClient['order'], 'upsert'>;
  refundRequest: Pick<PrismaClient['refundRequest'], 'deleteMany'>;
  userMemory: Pick<PrismaClient['userMemory'], 'deleteMany'>;
  $queryRaw: PrismaClient['$queryRaw'];
  $executeRaw: PrismaClient['$executeRaw'];
}

export interface ResetSummary {
  accounts: number;
  orders: number;
  refunds: number;
  memories: number;
  checkpointRows: number;
}

/**
 * Restores the demo accounts and orders (dates relative to `now`) and clears the demo customers'
 * refund requests, memory and chat threads. Traces and every other customer are left alone.
 * Run inside one transaction so a failure changes nothing.
 */
export async function resetDemo(
  tx: ResetClient,
  now: Date,
  passwordHash: string,
): Promise<ResetSummary> {
  for (const account of DEMO_ACCOUNTS) {
    const data = { ...account, passwordHash };
    await tx.customer.upsert({
      where: { id: account.id },
      create: data,
      update: data,
    });
  }
  const orders = demoOrders(now);
  for (const order of orders) {
    await tx.order.upsert({
      where: { id: order.id },
      create: order,
      update: order,
    });
  }

  const customerId = { in: [...DEMO_CUSTOMER_IDS] };
  const refunds = await tx.refundRequest.deleteMany({ where: { customerId } });
  const memories = await tx.userMemory.deleteMany({ where: { customerId } });

  let checkpointRows = 0;
  for (const table of CHECKPOINT_TABLES) {
    const [{ exists }] = await tx.$queryRaw<[{ exists: boolean }]>`
      SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS "exists"`;
    if (!exists) continue;
    for (const id of DEMO_CUSTOMER_IDS) {
      // The table name comes from the fixed list above; the thread prefix is a bound parameter.
      checkpointRows += await deleteThreads(tx, table, `${id}:%`);
    }
  }

  return {
    accounts: DEMO_ACCOUNTS.length,
    orders: orders.length,
    refunds: refunds.count,
    memories: memories.count,
    checkpointRows,
  };
}

function deleteThreads(
  tx: ResetClient,
  table: (typeof CHECKPOINT_TABLES)[number],
  prefix: string,
): Promise<number> {
  switch (table) {
    case 'checkpoints':
      return tx.$executeRaw`DELETE FROM checkpoints WHERE thread_id LIKE ${prefix}`;
    case 'checkpoint_blobs':
      return tx.$executeRaw`DELETE FROM checkpoint_blobs WHERE thread_id LIKE ${prefix}`;
    case 'checkpoint_writes':
      return tx.$executeRaw`DELETE FROM checkpoint_writes WHERE thread_id LIKE ${prefix}`;
  }
}

export function formatSummary(s: ResetSummary): string {
  return `Demo reset: ${s.accounts} accounts, ${s.orders} orders, ${s.refunds} refund requests, ${s.memories} memories, ${s.checkpointRows} checkpoint rows removed`;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const summary = await prisma.$transaction((tx) =>
      resetDemo(tx, new Date(), passwordHash),
    );
    console.log(formatSummary(summary));
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
