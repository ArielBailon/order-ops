import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
        // A database that accepts no connections must fail a query, not hang it forever.
        connectionTimeoutMillis: 10_000,
      }),
    });
  }

  /** After the HTTP server has closed, so streams ended by shutdown hooks still reach the database. */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
