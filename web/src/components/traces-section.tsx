'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendPage,
  formatCount,
  formatMs,
  formatUsd,
  hasMore,
  langfuseTraceUrl,
  routeLabel,
  startPages,
  type TraceDetail,
  type TraceFilters,
  type TraceListResponse,
  type TracePages,
  tracesQuery,
} from '@/lib/observability';
import { SectionState } from './section-state';
import { useViewerData } from './use-viewer-data';

const ROUTES = ['faq', 'order', 'refund', 'out_of_scope'];
const STATUSES = ['ok', 'error', 'aborted'];
const time = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function TracesSection({
  langfuseProjectUrl,
  onSessionExpired,
}: {
  langfuseProjectUrl: string | undefined;
  onSessionExpired: () => void;
}) {
  const [pages, setPages] = useState<TracePages>(() => startPages({}));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Guards against a slow page for old filters landing after the filters changed.
  const generation = useRef(0);

  const load = useCallback(
    async (filters: TraceFilters, before?: string) => {
      const mine = generation.current;
      setLoading(true);
      setError(null);
      try {
        const query = tracesQuery(filters, before);
        const res = await fetch(
          `/api/viewer/traces${query ? `?${query}` : ''}`,
          {
            cache: 'no-store',
          },
        );
        if (mine !== generation.current) return;
        if (res.status === 401) return onSessionExpired();
        const body = (await res.json().catch(() => null)) as
          (TraceListResponse & { message?: string }) | null;
        if (mine !== generation.current) return;
        if (!res.ok || !body?.traces)
          return setError(body?.message ?? 'The traces could not be loaded.');
        setPages((current) => appendPage(current, body));
      } catch {
        if (mine === generation.current)
          setError('The console is not reachable right now.');
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [onSessionExpired],
  );

  // Each run starts from an empty list and its cleanup invalidates a load still in flight, so a
  // re-run (React runs mount effects twice in development) never appends the first page twice.
  useEffect(() => {
    generation.current += 1;
    setPages(startPages({}));
    setSelected(null);
    void load({});
    return () => {
      generation.current += 1;
    };
  }, [load]);

  function changeFilters(filters: TraceFilters) {
    generation.current += 1;
    setPages(startPages(filters));
    setSelected(null);
    void load(filters);
  }

  return (
    <section aria-labelledby="traces-heading">
      <h2 id="traces-heading">Traces</h2>
      <div className="filters">
        <label>
          Route{' '}
          <select
            value={pages.filters.route ?? ''}
            onChange={(event) =>
              changeFilters({
                ...pages.filters,
                route: event.target.value || undefined,
              })
            }
          >
            <option value="">All</option>
            {ROUTES.map((route) => (
              <option key={route} value={route}>
                {route}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{' '}
          <select
            value={pages.filters.status ?? ''}
            onChange={(event) =>
              changeFilters({
                ...pages.filters,
                status: event.target.value || undefined,
              })
            }
          >
            <option value="">All</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="error">
          {error}{' '}
          <button
            type="button"
            onClick={() =>
              void load(pages.filters, pages.nextBefore ?? undefined)
            }
          >
            Retry
          </button>
        </p>
      )}
      {pages.loaded && pages.traces.length === 0 && (
        <p className="muted">No traces match these filters.</p>
      )}
      {pages.traces.length > 0 && (
        <table className="traces">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Latency</th>
              <th scope="col">Calls</th>
              <th scope="col">Cost</th>
              <th scope="col">Failovers</th>
              <th scope="col">
                <span className="visually-hidden">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pages.traces.map((trace) => (
              <tr
                key={trace.id}
                className={trace.id === selected ? 'selected' : undefined}
              >
                <td>{time.format(new Date(trace.createdAt))}</td>
                <td>{routeLabel(trace.route)}</td>
                <td>{trace.status}</td>
                <td>{formatMs(trace.latencyMs)}</td>
                <td>{formatCount(trace.calls)}</td>
                <td>{formatUsd(trace.costUsd)}</td>
                <td>{formatCount(trace.failovers)}</td>
                <td>
                  <button
                    type="button"
                    aria-pressed={trace.id === selected}
                    onClick={() => setSelected(trace.id)}
                  >
                    Details
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {loading && <p className="muted">Loading…</p>}
      {hasMore(pages) && !loading && (
        <button
          type="button"
          onClick={() =>
            void load(pages.filters, pages.nextBefore ?? undefined)
          }
        >
          Load more
        </button>
      )}

      {selected && (
        <TraceDetailView
          id={selected}
          langfuseProjectUrl={langfuseProjectUrl}
          onSessionExpired={onSessionExpired}
        />
      )}
    </section>
  );
}

function TraceDetailView({
  id,
  langfuseProjectUrl,
  onSessionExpired,
}: {
  id: string;
  langfuseProjectUrl: string | undefined;
  onSessionExpired: () => void;
}) {
  const { data, reload } = useViewerData<TraceDetail>(
    `/api/viewer/traces/${encodeURIComponent(id)}`,
    onSessionExpired,
  );
  const langfuse = langfuseTraceUrl(langfuseProjectUrl, id);

  return (
    <div className="trace-detail" aria-live="polite">
      <h3>Trace {id}</h3>
      <SectionState data={data} onRetry={reload}>
        {(trace) => (
          <>
            <dl className="trace-fields">
              <dt>Time</dt>
              <dd>{time.format(new Date(trace.createdAt))}</dd>
              <dt>Customer</dt>
              <dd>{trace.customerId}</dd>
              <dt>Thread</dt>
              <dd>{trace.threadId}</dd>
              <dt>Route</dt>
              <dd>{routeLabel(trace.route)}</dd>
              <dt>Tools</dt>
              <dd>{trace.tools.join(', ') || 'none'}</dd>
              <dt>Status</dt>
              <dd>{trace.status}</dd>
              <dt>Latency</dt>
              <dd>{formatMs(trace.latencyMs)}</dd>
              <dt>Failovers</dt>
              <dd>{formatCount(trace.failovers)}</dd>
              <dt>Cost</dt>
              <dd>{formatUsd(trace.costUsd)}</dd>
            </dl>
            {langfuse && (
              <p>
                <a href={langfuse} target="_blank" rel="noopener noreferrer">
                  Open in Langfuse
                </a>
              </p>
            )}
            <h4>Model calls, in call order</h4>
            {trace.calls.length === 0 ? (
              <p className="muted">No model call completed.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Tier</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Model</th>
                    <th scope="col">Input</th>
                    <th scope="col">Output</th>
                    <th scope="col">Cache read</th>
                    <th scope="col">Cache write</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.calls.map((call, index) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>{call.tier}</td>
                      <td>{call.provider}</td>
                      <td>{call.model}</td>
                      <td>{formatCount(call.inputTokens)}</td>
                      <td>{formatCount(call.outputTokens)}</td>
                      <td>{formatCount(call.cacheReadTokens)}</td>
                      <td>{formatCount(call.cacheWriteTokens)}</td>
                      <td>{formatMs(call.latencyMs)}</td>
                      <td>{formatUsd(call.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </SectionState>
    </div>
  );
}
