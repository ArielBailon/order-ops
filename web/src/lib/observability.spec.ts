import { describe, expect, it } from 'vitest';
import {
  appendPage,
  casesLabel,
  type EvalRun,
  formatCount,
  formatMs,
  formatPercent,
  formatUsd,
  hasMore,
  isEmptyWindow,
  judgeCostLabel,
  langfuseTraceUrl,
  routeLabel,
  startPages,
  type SummaryResponse,
  type TraceListItem,
  tracesQuery,
} from './observability';

const TRACE = '312f8254-84bd-4476-9e6b-FCCB699C4F4E';

describe('formatting', () => {
  it('formats counts, percentages, milliseconds and USD', () => {
    expect(formatCount(12345)).toBe('12,345');
    expect(formatPercent(0.25)).toBe('25%');
    expect(formatPercent(0.034)).toBe('3.4%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe('n/a');
    expect(formatMs(7391.4)).toBe('7,391 ms');
    expect(formatUsd(0.022947)).toBe('$0.0229');
    expect(formatUsd('0.017915')).toBe('$0.0179');
    expect(formatUsd(3.5)).toBe('$3.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe('not priced');
    expect(routeLabel(null)).toBe('no route');
  });

  it('treats a window with no requests as empty', () => {
    expect(isEmptyWindow({ requests: 0 } as SummaryResponse)).toBe(true);
    expect(isEmptyWindow({ requests: 3 } as SummaryResponse)).toBe(false);
  });
});

describe('langfuseTraceUrl', () => {
  it('appends the dashless lowercase id to an http(s) project URL', () => {
    expect(
      langfuseTraceUrl('https://us.cloud.langfuse.com/project/abc/', TRACE),
    ).toBe(
      'https://us.cloud.langfuse.com/project/abc/traces/312f825484bd44769e6bfccb699c4f4e',
    );
  });

  it.each([
    undefined,
    '',
    'javascript:alert(1)',
    'us.cloud.langfuse.com/project/abc',
  ])('gives no link for %j', (base) => {
    expect(langfuseTraceUrl(base, TRACE)).toBeNull();
  });
});

describe('trace paging', () => {
  const row = (id: string) => ({ id }) as TraceListItem;

  it('appends pages in order and hides "Load more" after the last page', () => {
    const first = appendPage(startPages({}), {
      traces: [row('c'), row('b')],
      nextBefore: 'b',
    });
    const last = appendPage(first, { traces: [row('a')], nextBefore: null });

    expect(hasMore(startPages({}))).toBe(false);
    expect(hasMore(first)).toBe(true);
    expect(last.traces.map((t) => t.id)).toEqual(['c', 'b', 'a']);
    expect(hasMore(last)).toBe(false);
  });

  it('starts over with no rows and no cursor when the filters change', () => {
    expect(startPages({ route: 'refund' })).toEqual({
      filters: { route: 'refund' },
      traces: [],
      nextBefore: null,
      loaded: false,
    });
  });

  it('builds the query from the set filters and the cursor only', () => {
    expect(tracesQuery({})).toBe('');
    expect(tracesQuery({ route: 'faq', status: 'error' }, 'abc')).toBe(
      'route=faq&status=error&before=abc',
    );
  });
});

describe('eval scorecard', () => {
  const run = (summary: Partial<EvalRun['summary']>, judged = false) =>
    ({
      judge: judged
        ? { provider: 'anthropic', model: 'm', rubricVersion: 1 }
        : null,
      summary: { cases: 41, ...summary },
    }) as EvalRun;

  it('labels a truncated run with the cases it ran', () => {
    expect(casesLabel(run({}))).toBe('41 cases');
    expect(casesLabel(run({ truncated: true, cases: 12, casesRun: 12 }))).toBe(
      '12 cases (truncated by the cost cap)',
    );
  });

  it('shows the judge cost only for judged runs', () => {
    expect(judgeCostLabel(run({ judgeCostUsd: 0.5 }))).toBeNull();
    expect(judgeCostLabel(run({ judgeCostUsd: 0.5 }, true))).toBe('$0.5000');
    expect(judgeCostLabel(run({ judgeCostUsd: null }, true))).toBe(
      'not priced',
    );
  });
});
