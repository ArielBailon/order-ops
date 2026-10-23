'use client';

import {
  formatCount,
  formatMs,
  formatPercent,
  formatUsd,
  isEmptyWindow,
  type MetricsWindow,
  routeLabel,
  type SummaryResponse,
} from '@/lib/observability';
import { SectionState } from './section-state';
import { useViewerData } from './use-viewer-data';

export function MetricsSection({
  metricsWindow,
  onSessionExpired,
}: {
  metricsWindow: MetricsWindow;
  onSessionExpired: () => void;
}) {
  const { data, reload } = useViewerData<SummaryResponse>(
    `/api/viewer/summary?window=${metricsWindow}`,
    onSessionExpired,
  );

  return (
    <section aria-labelledby="metrics-heading">
      <h2 id="metrics-heading">Metrics</h2>
      <SectionState data={data} onRetry={reload}>
        {(summary) =>
          isEmptyWindow(summary) ? (
            <p className="muted">No requests in this window.</p>
          ) : (
            <Metrics summary={summary} />
          )
        }
      </SectionState>
    </section>
  );
}

function Metrics({ summary }: { summary: SummaryResponse }) {
  const maxP95 = Math.max(1, ...summary.byRoute.map((row) => row.p95));
  const { conversations } = summary;
  return (
    <>
      <dl className="tiles">
        <Tile label="Requests" value={formatCount(summary.requests)} />
        <Tile label="Error rate" value={formatPercent(summary.errorRate)} />
        <Tile
          label="Failover rate"
          value={formatPercent(summary.failoverRate)}
        />
        <Tile
          label="Cached-token share"
          value={formatPercent(summary.cachedShare)}
        />
        <Tile
          label="Latency p50"
          value={summary.overall ? formatMs(summary.overall.p50) : 'n/a'}
        />
        <Tile
          label="Latency p95"
          value={summary.overall ? formatMs(summary.overall.p95) : 'n/a'}
        />
      </dl>

      <h3>Latency by route</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">Route</th>
            <th scope="col">Requests</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
          </tr>
        </thead>
        <tbody>
          {summary.byRoute.map((row) => (
            <tr key={row.route ?? 'none'}>
              <th scope="row">{routeLabel(row.route)}</th>
              <td>{formatCount(row.requests)}</td>
              <td>{formatMs(row.p50)}</td>
              <td>
                <span className="bar-cell">
                  <span
                    className="bar"
                    style={{ width: `${(row.p95 / maxP95) * 100}%` }}
                    aria-hidden="true"
                  />
                  {formatMs(row.p95)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Cost per conversation</h3>
      <dl className="tiles">
        <Tile label="Conversations" value={formatCount(conversations.count)} />
        <Tile label="Average" value={formatUsd(conversations.averageUsd)} />
        <Tile label="Most expensive" value={formatUsd(conversations.maxUsd)} />
        <Tile label="Total" value={formatUsd(conversations.totalUsd)} />
        <Tile
          label="Calls without a price"
          value={formatCount(conversations.unpriced)}
        />
      </dl>

      <h3>Tokens and cost by model</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Model</th>
            <th scope="col">Calls</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cache read</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {summary.models.map((row) => (
            <tr key={`${row.provider}/${row.model}`}>
              <td>{row.provider}</td>
              <th scope="row">{row.model}</th>
              <td>{formatCount(row.calls)}</td>
              <td>{formatCount(row.inputTokens)}</td>
              <td>{formatCount(row.outputTokens)}</td>
              <td>{formatCount(row.cacheReadTokens)}</td>
              <td>{formatUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
