import type { PrismaService } from '@app/prisma';
import { PrismaTraceStore, type TraceRecord } from './trace.store.js';

const call = {
  tier: 'cheap',
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 300,
  costUsd: 0.0002,
};

const trace: TraceRecord = {
  customerId: 'cus_ana',
  threadId: 'thread-1',
  route: 'order',
  tools: ['get_order'],
  status: 'ok',
  latencyMs: 1200,
  calls: [call, { ...call, tier: 'strong', costUsd: null }],
};

describe('PrismaTraceStore', () => {
  const create = vi.fn();
  const store = new PrismaTraceStore({
    chatTrace: { create },
  } as unknown as PrismaService);

  beforeEach(() => create.mockReset().mockResolvedValue({}));

  it('writes the trace and all its calls in one nested create', async () => {
    await store.record(trace);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        customerId: 'cus_ana',
        threadId: 'thread-1',
        route: 'order',
        tools: ['get_order'],
        status: 'ok',
        latencyMs: 1200,
        calls: { create: trace.calls },
      },
    });
  });

  it('stores only metadata fields', async () => {
    await store.record(trace);

    const { data } = create.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual([
      'calls',
      'customerId',
      'latencyMs',
      'route',
      'status',
      'threadId',
      'tools',
    ]);
  });

  it('lets a store failure reach the caller', async () => {
    const failing = new PrismaTraceStore({
      chatTrace: {
        create: () => Promise.reject(new Error('db down')),
      },
    } as unknown as PrismaService);

    await expect(failing.record(trace)).rejects.toThrow('db down');
  });
});
