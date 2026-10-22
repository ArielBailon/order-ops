import {
  conversations,
  latency,
  models,
  type QueryRunner,
  rateCounts,
  share,
} from './trace-metrics.js';

const since = new Date('2026-10-01T00:00:00Z');
const until = new Date('2026-10-08T00:00:00Z');

/** Records every statement and answers with the given rows. */
function fakeRunner(rows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = (async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return rows;
  }) as QueryRunner;
  return { calls, query };
}

describe('trace metrics', () => {
  it.each([
    ['latency overall', (q: QueryRunner) => latency(q, { since }, false)],
    ['latency by route', (q: QueryRunner) => latency(q, { since }, true)],
    ['conversations', (q: QueryRunner) => conversations(q, { since })],
    ['models', (q: QueryRunner) => models(q, { since })],
    ['rate counts', (q: QueryRunner) => rateCounts(q, { since })],
  ])('%s binds since as $1 and never interpolates it', async (_label, run) => {
    const { calls, query } = fakeRunner();

    await run(query);

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([since]);
    expect(calls[0].sql).toContain('"createdAt" >= $1');
    expect(calls[0].sql).not.toContain('2026');
    expect(calls[0].sql).not.toContain('$2');
  });

  it.each([
    ['latency', (q: QueryRunner) => latency(q, { since, until }, true)],
    ['conversations', (q: QueryRunner) => conversations(q, { since, until })],
    ['models', (q: QueryRunner) => models(q, { since, until })],
    ['rate counts', (q: QueryRunner) => rateCounts(q, { since, until })],
  ])('%s binds an until bound as $2, exclusive', async (_label, run) => {
    const { calls, query } = fakeRunner();

    await run(query);

    expect(calls[0].params).toEqual([since, until]);
    expect(calls[0].sql).toMatch(/"createdAt" < \$2/);
  });

  it('groups latency by route only when asked', async () => {
    const { calls, query } = fakeRunner();

    await latency(query, { since }, false);
    await latency(query, { since }, true);

    expect(calls[0].sql).not.toContain('GROUP BY');
    expect(calls[1].sql).toContain('GROUP BY route');
  });

  it('returns the rows of each query unchanged', async () => {
    const row = { route: 'order', requests: 3, p50: 900, p95: 1500 };
    const { query } = fakeRunner([row]);

    await expect(latency(query, { since }, true)).resolves.toEqual([row]);
  });

  it('counts requests, errors and failovers, and zeros when no row comes back', async () => {
    await expect(
      rateCounts(
        fakeRunner([{ requests: 10, errors: 2, failovers: 1 }]).query,
        {
          since,
        },
      ),
    ).resolves.toEqual({ requests: 10, errors: 2, failovers: 1 });
    await expect(rateCounts(fakeRunner([]).query, { since })).resolves.toEqual({
      requests: 0,
      errors: 0,
      failovers: 0,
    });
  });

  it('computes a share without dividing by zero', () => {
    expect(share(2, 10)).toBe(0.2);
    expect(share(0, 0)).toBe(0);
    expect(share(5, 0)).toBe(0);
  });
});
