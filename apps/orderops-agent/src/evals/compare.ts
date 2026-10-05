import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ResultFile } from './cli.js';
import { METRIC_NAMES } from './metrics.js';

const RESULTS_DIR = fileURLToPath(
  new URL('../../../../evals/results', import.meta.url),
);
export const COMPARISON_PATH = fileURLToPath(
  new URL('../../../../evals/COMPARISON.md', import.meta.url),
);

const percent = (rate: { rate: number | null }) =>
  rate.rate === null ? 'n/a' : `${Math.round(rate.rate * 100)}%`;

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The newest run of each provider, in provider-name order. */
export function latestPerProvider(results: ResultFile[]): ResultFile[] {
  const latest = new Map<string, ResultFile>();
  for (const result of results) {
    const current = latest.get(result.provider);
    if (!current || result.runAt > current.runAt)
      latest.set(result.provider, result);
  }
  return [...latest.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

/** Markdown table comparing the latest run of each provider. */
export function buildComparison(results: ResultFile[]): string {
  const rows = latestPerProvider(results);
  if (rows.length === 0) return 'No eval results found.\n';

  const header = [
    'Provider',
    'Models (cheap / strong)',
    'Cases',
    'Pass',
    ...METRIC_NAMES,
    'Cost',
    'p50 latency',
    'Run',
  ];
  const lines = [
    '# Provider comparison',
    '',
    'Latest run per provider from `evals/results/`. Answer quality is n/a for runs made without `--judge`.',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => {
      const latency = median(r.cases.map((c) => c.latencyMs));
      return `| ${[
        r.provider,
        `${r.models.cheap} / ${r.models.strong}`,
        r.summary.cases,
        percent(r.summary.pass),
        ...METRIC_NAMES.map((name) =>
          // Files written before the judge existed have no answerQuality rate.
          percent(r.summary.metrics[name] ?? { rate: null }),
        ),
        r.summary.costUsd === null ? 'n/a' : `$${r.summary.costUsd.toFixed(4)}`,
        latency === null ? 'n/a' : `${Math.round(latency)} ms`,
        `${r.runAt.slice(0, 10)} @ ${r.gitSha}`,
      ].join(' | ')} |`;
    }),
  ];

  const hashes = new Set(rows.map((r) => r.datasetSha256));
  const judges = new Set(
    rows.map((r) =>
      r.judge ? `${r.judge.model} v${r.judge.rubricVersion}` : null,
    ),
  );
  if (hashes.size > 1)
    lines.push(
      '',
      '> **Not comparable:** these runs used different dataset versions.',
    );
  if (judges.size > 1)
    lines.push(
      '',
      '> **Not comparable on answer quality:** the runs used different judges or rubric versions, or not all were judged.',
    );
  return `${lines.join('\n')}\n`;
}

export async function readResults(dir: string): Promise<ResultFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(dir, name), 'utf8')) as ResultFile,
    ),
  );
}

/** Prints the table; writes `evals/COMPARISON.md` only when there are results. */
export async function main(
  dir: string = RESULTS_DIR,
  outPath: string = COMPARISON_PATH,
): Promise<string> {
  const results = await readResults(dir);
  const table = buildComparison(results);
  if (results.length > 0) await writeFile(outPath, table, 'utf8');
  console.log(table);
  return table;
}

// Runs only when started directly (`npm run eval:compare`), not when a spec imports this module.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
