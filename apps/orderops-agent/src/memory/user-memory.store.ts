import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';

export const USER_MEMORY = Symbol('USER_MEMORY');

/** Long-term facts per customer, keyed by the customer id from the verified JWT. */
export interface UserMemoryStore {
  get(customerId: string): Promise<string[]>;
  replace(customerId: string, facts: string[]): Promise<void>;
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

  async replace(customerId: string, facts: string[]): Promise<void> {
    await this.prisma.userMemory.upsert({
      where: { customerId },
      create: { customerId, facts },
      update: { facts },
    });
  }
}
