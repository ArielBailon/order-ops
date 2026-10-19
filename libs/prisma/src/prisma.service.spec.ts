import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from './prisma.service.js';

function service(): PrismaService {
  const config = {
    getOrThrow: () => 'postgresql://u:p@127.0.0.1:5432/db',
  } as unknown as ConfigService;
  return new PrismaService(config);
}

describe('PrismaService shutdown', () => {
  it('disconnects after the application shutdown hooks, not in onModuleDestroy', async () => {
    const prisma = service();
    const disconnect = vi.spyOn(prisma, '$disconnect').mockResolvedValue();

    expect('onModuleDestroy' in prisma).toBe(false);
    await prisma.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
