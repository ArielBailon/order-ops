/** Time windows the dashboard offers for its metrics, as hours back from now. */
export const WINDOWS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const;
export type MetricsWindow = keyof typeof WINDOWS;

export function isWindow(value: unknown): value is MetricsWindow {
  return typeof value === 'string' && Object.hasOwn(WINDOWS, value);
}

/** The `since` the gateway expects for a window, as ISO 8601 UTC. */
export function sinceFor(window: MetricsWindow, now: Date): string {
  return new Date(now.getTime() - WINDOWS[window] * 3_600_000).toISOString();
}

// Mirrors of the gateway's observability API responses (10b), as far as the console uses them.

export interface LatencyStats {
  requests: number;
  p50: number;
  p95: number;
}

export interface ModelRow {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface SummaryResponse {
  since: string;
  until: string;
  requests: number;
  errorRate: number;
  failoverRate: number;
  overall: LatencyStats | null;
  byRoute: (LatencyStats & { route: string | null })[];
  conversations: {
    count: number;
    totalUsd: number;
    averageUsd: number;
    maxUsd: number;
    unpriced: number;
  };
  models: ModelRow[];
  cachedShare: number;
}

export interface TraceListItem {
  id: string;
  createdAt: string;
  customerId: string;
  threadId: string;
  route: string | null;
  tools: string[];
  status: 'ok' | 'error' | 'aborted';
  latencyMs: number;
  failovers: number;
  calls: number;
  costUsd: string | null;
}

export interface TraceListResponse {
  traces: TraceListItem[];
  nextBefore: string | null;
}

export interface TraceCall {
  tier: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: string | null;
  createdAt: string;
}

export type TraceDetail = Omit<TraceListItem, 'calls'> & { calls: TraceCall[] };

export interface Rate {
  passed: number;
  total: number;
  rate: number | null;
}

export interface Rates {
  cases: number;
  pass: Rate;
  metrics: Record<string, Rate>;
}

export interface EvalRun {
  runAt: string;
  gitSha: string;
  datasetSha256: string;
  provider: string;
  models: { cheap: string; strong: string };
  judge: { provider: string; model: string; rubricVersion: number } | null;
  summary: Rates & {
    byCategory: Record<string, Rates>;
    errors: number;
    costUsd: number | null;
    judgeCostUsd?: number | null;
    truncated?: boolean;
    casesRun?: number;
  };
  caseCount: number;
}

export interface LatestEvalsResponse {
  providers: EvalRun[];
  comparable: boolean;
}

// Formatting. Every value the dashboard shows goes through one of these, so null and edge cases
// look the same everywhere.

const integer = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return integer.format(value);
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return 'n/a';
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}

export function formatMs(ms: number): string {
  return `${integer.format(Math.round(ms))} ms`;
}

/** USD estimates: cents for a dollar or more, four decimals below (single calls cost fractions of a cent). */
export function formatUsd(value: number | string | null): string {
  if (value === null) return 'not priced';
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return 'not priced';
  return `$${amount.toFixed(amount >= 1 || amount === 0 ? 2 : 4)}`;
}

export function routeLabel(route: string | null): string {
  return route ?? 'no route';
}

/** The window had no requests: show one message instead of empty tables. */
export function isEmptyWindow(summary: SummaryResponse): boolean {
  return summary.requests === 0;
}

/**
 * The Langfuse trace page for a stored trace: Langfuse ids are the `ChatTrace.id` without dashes.
 * Null when the project URL is missing or not http(s), so no link is shown.
 */
export function langfuseTraceUrl(
  projectUrl: string | undefined,
  traceId: string,
): string | null {
  if (!projectUrl || !/^https?:\/\//i.test(projectUrl)) return null;
  return `${projectUrl.replace(/\/+$/, '')}/traces/${traceId.replace(/-/g, '').toLowerCase()}`;
}

// Trace explorer paging.

export interface TraceFilters {
  route?: string;
  status?: string;
}

export interface TracePages {
  filters: TraceFilters;
  traces: TraceListItem[];
  /** Cursor for the next page; null once the last page arrived. */
  nextBefore: string | null;
  loaded: boolean;
}

/** A fresh list for new filters: no rows and no cursor until the first page arrives. */
export function startPages(filters: TraceFilters): TracePages {
  return { filters, traces: [], nextBefore: null, loaded: false };
}

export function appendPage(
  pages: TracePages,
  page: TraceListResponse,
): TracePages {
  return {
    ...pages,
    traces: [...pages.traces, ...page.traces],
    nextBefore: page.nextBefore,
    loaded: true,
  };
}

export function hasMore(pages: TracePages): boolean {
  return pages.loaded && pages.nextBefore !== null;
}

/** Query string for `/api/viewer/traces`: only the set filters and the cursor. */
export function tracesQuery(filters: TraceFilters, before?: string): string {
  const query = new URLSearchParams();
  if (filters.route) query.set('route', filters.route);
  if (filters.status) query.set('status', filters.status);
  if (before) query.set('before', before);
  return query.toString();
}

// Eval scorecard.

export function casesLabel(run: EvalRun): string {
  const { summary } = run;
  return summary.truncated
    ? `${formatCount(summary.casesRun ?? summary.cases)} cases (truncated by the cost cap)`
    : `${formatCount(summary.cases)} cases`;
}

/** Judge spend is shown only for judged runs. */
export function judgeCostLabel(run: EvalRun): string | null {
  return run.judge ? formatUsd(run.summary.judgeCostUsd ?? null) : null;
}
