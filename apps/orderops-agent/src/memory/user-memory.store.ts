import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { mergeFacts } from './facts.js';

export const USER_MEMORY = Symbol('USER_MEMORY');

/** Long-term facts per customer, keyed by the customer id from the verified JWT. */
export interface UserMemoryStore {
  get(customerId: string): Promise<string[]>;
  /** Merges new facts into the stored ones; concurrent calls for one customer never lose a fact. */
  add(customerId: string, added: string[]): Promise<void>;
}

@Injectable()
export class PrismaUserMemoryStore implements UserMemoryStore {
  constructor(private readonly prisma: PrismaService) {}

  async get(customerId: string): Promise<string[]> {
    const row = await this.prisma.userMemory.findUnique({
      where: { customerId },
    });
    return row?.facts ?? [];
  }

  async add(customerId: string, added: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The lock also covers a customer without a row yet, which a row lock cannot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${customerId}))`;
      const row = await tx.userMemory.findUnique({ where: { customerId } });
      const facts = mergeFacts(row?.facts ?? [], added);
      await tx.userMemory.upsert({
        where: { customerId },
        create: { customerId, facts },
        update: { facts },
      });
    });
  }
}
