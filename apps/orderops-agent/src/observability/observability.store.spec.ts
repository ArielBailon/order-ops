import type { PrismaService } from '@app/prisma';
import type { QueryRunner } from '../trace/trace-metrics.js';
import {
  buildSummary,
  PrismaObservabilityStore,
  sumCost,
} from './observability.store.js';

const since = new Date('2026-10-01T00:00:00Z');
const now = new Date('2026-10-08T00:00:00Z');

/** Answers each metrics query by the first words of its SQL. */
function runner(rows: {
  overall?: unknown[];
  byRoute?: unknown[];
  conversations?: unknown[];
  models?: unknown[];
  counts?: unknown[];
}): QueryRunner {
  return (async (sql: string) => {
    if (sql.includes('FROM "ChatTrace" t JOIN'))
      return rows.conversations ?? [];
    if (sql.includes('FROM "LlmCall" c')) return rows.models ?? [];
    if (sql.includes('FILTER (WHERE status')) return rows.counts ?? [];
    if (sql.includes('GROUP BY route')) return rows.byRoute ?? [];
    return rows.overall ?? [];
  }) as QueryRunner;
}

describe('buildSummary', () => {
  it('turns the report rows into JSON with rates, rounded money and the cached share', async () => {
    const summary = await buildSummary(
      runner({
        overall: [{ route: null, requests: 4, p50: 900, p95: 2000 }],
        byRoute: [{ route: 'order', requests: 4, p50: 900, p95: 2000 }],
        conversations: [
          {
            customerId: 'cus_ana',
            threadId: 't1',
            costUsd: 0.1234564,
            unpriced: 0,
          },
          { customerId: 'cus_ben', threadId: 't2', costUsd: 0.2, unpriced: 1 },
        ],
        models: [
          {
            provider: 'anthropic',
            model: 'm',
            calls: 6,
            inputTokens: 1000,
            outputTokens: 100,
            cacheReadTokens: 250,
            costUsd: 0.3234564,
          },
        ],
        counts: [{ requests: 4, errors: 1, failovers: 2 }],
      }),
      { since },
      now,
    );

    expect(summary).toEqual({
      since: since.toISOString(),
      until: now.toISOString(),
      requests: 4,
      errorRate: 0.25,
      failoverRate: 0.5,
      overall: { requests: 4, p50: 900, p95: 2000 },
      byRoute: [{ route: 'order', requests: 4, p50: 900, p95: 2000 }],
      conversations: {
        count: 2,
        totalUsd: 0.323456,
        averageUsd: 0.161728,
        maxUsd: 0.2,
        unpriced: 1,
      },
      models: [
        {
          provider: 'anthropic',
          model: 'm',
          calls: 6,
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 250,
          costUsd: 0.323456,
        },
      ],
      cachedShare: 0.25,
    });
  });

  it('reports no overall latency and zero rates without traces', async () => {
    const summary = await buildSummary(
      runner({ overall: [{ route: null, requests: 0, p50: null, p95: null }] }),
      { since },
      now,
    );

    expect(summary).toMatchObject({
      requests: 0,
      errorRate: 0,
      failoverRate: 0,
      overall: null,
      byRoute: [],
      conversations: {
        count: 0,
        totalUsd: 0,
        averageUsd: 0,
        maxUsd: 0,
        unpriced: 0,
      },
      models: [],
      cachedShare: 0,
    });
  });
});

describe('sumCost', () => {
  it('sums priced costs to six decimals and ignores unpriced ones', () => {
    expect(
      sumCost(['0.000100', 0.0002, null, { toString: () => '0.0000005' }]),
    ).toBe('0.000301');
  });

  it('is null when nothing had a price', () => {
    expect(sumCost([])).toBeNull();
    expect(sumCost([null, null])).toBeNull();
  });
});

describe('PrismaObservabilityStore', () => {
  const trace = (
    id: string,
    createdAt: string,
    costs: (string | null)[] = [],
  ) => ({
    id,
    createdAt: new Date(createdAt),
    customerId: 'cus_ana',
    threadId: 'thread-1',
    route: 'order',
    tools: ['get_order'],
    status: 'ok',
    latencyMs: 1200,
    failovers: 0,
    calls: costs.map((costUsd) => ({ costUsd })),
  });
  const findMany = vi.fn();
  const findUnique = vi.fn();
  const store = new PrismaObservabilityStore({
    chatTrace: { findMany, findUnique },
  } as unknown as PrismaService);

  beforeEach(() => {
    findMany.mockReset();
    findUnique.mockReset();
  });

  it('asks for one extra row, newest first, and returns a cursor when there is more', async () => {
    findMany.mockResolvedValue([
      trace('c', '2026-10-03T00:00:00Z', ['0.000100', null]),
      trace('b', '2026-10-02T00:00:00Z'),
      trace('a', '2026-10-01T00:00:00Z'),
    ]);

    const page = await store.listTraces({ limit: 2 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    expect(page?.traces.map((t) => t.id)).toEqual(['c', 'b']);
    expect(page?.traces[0]).toMatchObject({ calls: 2, costUsd: '0.000100' });
    expect(page?.traces[1]).toMatchObject({ calls: 0, costUsd: null });
    expect(page?.nextBefore).toBe('b');
  });

  it('has no cursor on the last page', async () => {
    findMany.mockResolvedValue([trace('a', '2026-10-01T00:00:00Z')]);

    expect((await store.listTraces({ limit: 2 }))?.nextBefore).toBeNull();
  });

  it('passes the window, route and status filters through', async () => {
    findMany.mockResolvedValue([]);
    const until = new Date('2026-10-05T00:00:00Z');

    await store.listTraces({
      limit: 10,
      since,
      until,
      route: 'refund',
      status: 'error',
    });

    expect(findMany.mock.calls[0][0].where).toEqual({
      createdAt: { gte: since, lt: until },
      route: 'refund',
      status: 'error',
    });
  });

  it('pages strictly after the cursor trace by time then id', async () => {
    const at = new Date('2026-10-02T00:00:00Z');
    findUnique.mockResolvedValue({ createdAt: at, id: 'b' });
    findMany.mockResolvedValue([]);

    await store.listTraces({ limit: 10, before: 'b' });

    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'b' } }],
    });
  });

  it('returns null for an unknown cursor without listing', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      store.listTraces({ limit: 10, before: 'nope' }),
    ).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('maps one trace with its calls, and null when missing', async () => {
    findUnique.mockResolvedValueOnce({
      ...trace('a', '2026-10-01T00:00:00Z'),
      calls: [
        {
          tier: 'cheap',
          provider: 'anthropic',
          model: 'm',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          latencyMs: 300,
          costUsd: '0.000125',
          createdAt: new Date('2026-10-01T00:00:01Z'),
        },
      ],
    });

    const detail = await store.getTrace('a');

    expect(detail).toMatchObject({
      id: 'a',
      costUsd: '0.000125',
      calls: [
        {
          tier: 'cheap',
          costUsd: '0.000125',
          createdAt: '2026-10-01T00:00:01.000Z',
        },
      ],
    });
    findUnique.mockResolvedValueOnce(null);
    await expect(store.getTrace('missing')).resolves.toBeNull();
  });
});
