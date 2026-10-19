import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController, READY_TIMEOUT_MS } from './health.controller.js';
import type { PrismaService } from './prisma.service.js';

function controller(queryRaw: () => Promise<unknown>): HealthController {
  return new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);
}

describe('HealthController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports liveness without touching the database', () => {
    const queryRaw = vi.fn();
    expect(controller(queryRaw).health()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('is ready when the database answers', async () => {
    await expect(controller(async () => [{ '?column?': 1 }]).ready()).resolves.toEqual({
      status: 'ok',
    });
  });

  it('answers 503 without detail when the query fails', async () => {
    const result = controller(async () => {
      throw new Error('password authentication failed for user "orderops"');
    }).ready();
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: { status: 'unavailable' },
    });
  });

  it('answers 503 when the database does not answer in time', async () => {
    vi.useFakeTimers();
    const result = controller(() => new Promise(() => {})).ready();
    const assertion = expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await assertion;
  });
});
