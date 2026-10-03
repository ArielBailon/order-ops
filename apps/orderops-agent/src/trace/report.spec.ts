import { formatReport, type ReportData } from './report.js';

const since = new Date('2026-10-01T00:00:00Z');

const data: ReportData = {
  since,
  overall: { route: null, requests: 10, p50: 800, p95: 2400 },
  byRoute: [
    { route: 'order', requests: 6, p50: 900, p95: 2500 },
    { route: null, requests: 1, p50: 50, p95: 50 },
  ],
  conversations: [
    { customerId: 'c1', threadId: 'a', costUsd: 0.01, unpriced: 0 },
    { customerId: 'c2', threadId: 'a', costUsd: 0.03, unpriced: 2 },
  ],
  models: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      calls: 8,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 250,
      costUsd: 0.04,
    },
  ],
};

describe('formatReport', () => {
  it('prints latency, per-conversation cost, per-model totals and cache share', () => {
    const report = formatReport(data);

    expect(report).toContain('p95 2400 ms');
    expect(report).toContain('order');
    expect(report).toContain('(no route)');
    expect(report).toContain('conversations  2');
    expect(report).toContain('total          $0.0400');
    expect(report).toContain('average        $0.0200');
    expect(report).toContain('max            $0.0300');
    expect(report).toContain('2 call(s) had no price');
    expect(report).toContain('anthropic/claude-sonnet-5');
    expect(report).toContain('cached 25.0%');
    expect(report).toContain('Cached-token share of input: 25.0%');
  });

  it('says so when the window has no traces', () => {
    expect(
      formatReport({
        ...data,
        overall: null,
        byRoute: [],
        conversations: [],
        models: [],
      }),
    ).toContain('No traces recorded');
  });
});
