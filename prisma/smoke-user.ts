import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../libs/prisma/src/generated/client.js';
import { hashPassword } from '../libs/auth/src/password.js';

// The login the deploy smoke test uses (deploy/smoke.sh). One customer without orders; the
// password comes from the environment so it never lives in the repo. Rerunning rotates it.
const MIN_PASSWORD_LENGTH = 16;

async function main(): Promise<void> {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email) throw new Error('set SMOKE_EMAIL');
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`set SMOKE_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters)`);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const data = {
      id: 'cus_smoke',
      name: 'Smoke Test',
      email,
      tier: 'standard',
      role: 'customer',
      passwordHash: await hashPassword(password),
    } as const;
    await prisma.customer.upsert({ where: { id: data.id }, create: data, update: data });
    console.log(`smoke user ready: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
