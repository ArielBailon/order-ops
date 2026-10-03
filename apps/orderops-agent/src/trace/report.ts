export interface LatencyRow {
  /** Null for requests that failed before routing. */
  route: string | null;
  requests: number;
  p50: number;
  p95: number;
}

export interface ConversationRow {
  threadId: string;
  /** Null-priced calls are left out of the sum; `unpriced` counts them. */
  costUsd: number;
  unpriced: number;
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

export interface ReportData {
  since: Date;
  overall: LatencyRow | null;
  byRoute: LatencyRow[];
  conversations: ConversationRow[];
  models: ModelRow[];
}

const usd = (value: number) => `$${value.toFixed(4)}`;
const ms = (value: number) => `${Math.round(value)} ms`;

const latencyLine = (label: string, row: LatencyRow) =>
  `  ${label.padEnd(14)} ${String(row.requests).padStart(6)} requests   p50 ${ms(row.p50)}   p95 ${ms(row.p95)}`;

/** Plain-text report of traces since a date. Costs are estimates from the in-repo price table. */
export function formatReport({
  since,
  overall,
  byRoute,
  conversations,
  models,
}: ReportData): string {
  const lines = [`Trace report since ${since.toISOString()}`, ''];
  if (!overall || overall.requests === 0) {
    lines.push('No traces recorded in this window.');
    return lines.join('\n');
  }

  lines.push('Request latency', latencyLine('all', overall));
  for (const row of byRoute)
    lines.push(latencyLine(row.route ?? '(no route)', row));

  const total = conversations.reduce((sum, c) => sum + c.costUsd, 0);
  const max = conversations.reduce((m, c) => Math.max(m, c.costUsd), 0);
  const unpriced = conversations.reduce((sum, c) => sum + c.unpriced, 0);
  lines.push(
    '',
    'Cost per conversation (estimate)',
    `  conversations  ${conversations.length}`,
    `  total          ${usd(total)}`,
    `  average        ${usd(conversations.length ? total / conversations.length : 0)}`,
    `  max            ${usd(max)}`,
  );
  if (unpriced > 0)
    lines.push(`  ${unpriced} call(s) had no price and are not counted`);

  lines.push('', 'By model');
  for (const m of models) {
    const share = m.inputTokens ? m.cacheReadTokens / m.inputTokens : 0;
    lines.push(
      `  ${`${m.provider}/${m.model}`.padEnd(52)} ${String(m.calls).padStart(5)} calls   in ${m.inputTokens}   out ${m.outputTokens}   cached ${(share * 100).toFixed(1)}%   ${usd(m.costUsd)}`,
    );
  }
  const input = models.reduce((s, m) => s + m.inputTokens, 0);
  const cached = models.reduce((s, m) => s + m.cacheReadTokens, 0);
  lines.push(
    '',
    `Cached-token share of input: ${input ? ((cached / input) * 100).toFixed(1) : '0.0'}%`,
  );
  return lines.join('\n');
}
