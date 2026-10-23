'use client';

import {
  casesLabel,
  type EvalRun,
  formatCount,
  formatPercent,
  formatUsd,
  judgeCostLabel,
  type LatestEvalsResponse,
} from '@/lib/observability';
import { SectionState } from './section-state';
import { useViewerData } from './use-viewer-data';

const time = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function EvalsSection({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}) {
  const { data, reload } = useViewerData<LatestEvalsResponse>(
    '/api/viewer/evals',
    onSessionExpired,
  );

  return (
    <section aria-labelledby="evals-heading">
      <h2 id="evals-heading">Evals</h2>
      <SectionState data={data} onRetry={reload}>
        {(evals) =>
          evals.providers.length === 0 ? (
            <p className="muted">
              No eval results are committed yet. Run <code>npm run eval</code>{' '}
              and commit <code>evals/results/</code>.
            </p>
          ) : (
            <>
              {!evals.comparable && (
                <p className="notice">
                  These runs used different datasets, so their scores are not
                  directly comparable.
                </p>
              )}
              <div className="eval-cards">
                {evals.providers.map((run) => (
                  <EvalCard key={run.provider} run={run} />
                ))}
              </div>
            </>
          )
        }
      </SectionState>
    </section>
  );
}

function EvalCard({ run }: { run: EvalRun }) {
  const { summary } = run;
  const judgeCost = judgeCostLabel(run);
  return (
    <article className="eval-card">
      <h3>{run.provider}</h3>
      <dl className="trace-fields">
        <dt>Run</dt>
        <dd>
          {time.format(new Date(run.runAt))} (
          <code>{run.gitSha.slice(0, 7)}</code>)
        </dd>
        <dt>Models</dt>
        <dd>
          {run.models.cheap} / {run.models.strong}
        </dd>
        <dt>Cases</dt>
        <dd>{casesLabel(run)}</dd>
        <dt>Pass rate</dt>
        <dd>
          {formatPercent(summary.pass.rate)} ({formatCount(summary.pass.passed)}{' '}
          of {formatCount(summary.pass.total)})
        </dd>
        <dt>Run errors</dt>
        <dd>{formatCount(summary.errors)}</dd>
        <dt>Agent cost</dt>
        <dd>{formatUsd(summary.costUsd)}</dd>
        {judgeCost && (
          <>
            <dt>Judge</dt>
            <dd>
              {run.judge?.model} ({judgeCost})
            </dd>
          </>
        )}
      </dl>
      <h4>By metric</h4>
      <table>
        <tbody>
          {Object.entries(summary.metrics).map(([name, rate]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{formatPercent(rate.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>By category</h4>
      <table>
        <tbody>
          {Object.entries(summary.byCategory).map(([name, rates]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{formatPercent(rates.pass.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
