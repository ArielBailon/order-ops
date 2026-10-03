import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPolicyChunks } from '../faq/policy-chunks.js';
import { MODEL_IDS, type Provider } from '../models/providers.js';
import {
  categorySchema,
  type EvalCase,
  type EvalCategory,
  loadDataset,
} from './dataset.js';
import { KeywordPolicySearch } from './fakes.js';
import {
  type CaseScore,
  METRIC_NAMES,
  scoreCase,
  summarize,
  type Summary,
} from './metrics.js';
import { type CaseRun, createEvalModels, runCases } from './run.js';

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'bedrock'];

const POLICIES_DIR = fileURLToPath(new URL('../../policies', import.meta.url));

export const RESULTS_DIR = fileURLToPath(
  new URL('../../../../evals/results', import.meta.url),
);

export const USAGE =
  'Usage: npm run eval -- --provider anthropic|openai|bedrock [--ids a,b] [--category normal|out_of_scope|adversarial] [--limit N]';

/** A bad flag or missing credential; reported as a message, never a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliOptions {
  provider: Provider;
  ids?: string[];
  category?: EvalCategory;
  limit?: number;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: 'string' },
        ids: { type: 'string' },
        category: { type: 'string' },
        limit: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new CliError(`${(error as Error).message}\n${USAGE}`);
  }

  const provider = PROVIDERS.find((p) => p === values.provider);
  if (!provider)
    throw new CliError(
      `--provider is required and must be one of ${PROVIDERS.join(', ')}.\n${USAGE}`,
    );
  const options: CliOptions = { provider };

  if (values.ids !== undefined) {
    options.ids = values.ids.split(',').filter(Boolean);
    if (options.ids.length === 0) throw new CliError('--ids needs case ids.');
  }
  if (values.category !== undefined) {
    const parsed = categorySchema.safeParse(values.category);
    if (!parsed.success)
      throw new CliError(
        `--category must be one of ${categorySchema.options.join(', ')}.`,
      );
    options.category = parsed.data;
  }
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1)
      throw new CliError('--limit must be a positive integer.');
    options.limit = limit;
  }
  return options;
}

/** `--ids` and `--category` narrow the dataset; `--limit` then keeps the first N. */
export function selectCases(
  cases: EvalCase[],
  { ids, category, limit }: Omit<CliOptions, 'provider'>,
): EvalCase[] {
  if (ids) {
    const known = new Set(cases.map((c) => c.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length)
      throw new CliError(`Unknown case id: ${unknown.join(', ')}`);
  }
  const selected = cases.filter(
    (c) =>
      (!ids || ids.includes(c.id)) && (!category || c.category === category),
  );
  if (selected.length === 0) throw new CliError('No cases match the filters.');
  return limit ? selected.slice(0, limit) : selected;
}

/** Live runs spend money, so a missing credential stops the run before any case. */
export function requireCredentials(
  provider: Provider,
  env: NodeJS.ProcessEnv,
): void {
  const variable = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    bedrock: 'AWS_REGION',
  }[provider];
  if (!env[variable])
    throw new CliError(`${variable} is not set (needed for ${provider}).`);
}

export interface ResultSummary extends Summary {
  /** Cases whose run threw or timed out. */
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Null when any call used a model without a price. */
  costUsd: number | null;
}

export interface ResultCase {
  id: string;
  category: EvalCategory;
  scores: Omit<CaseScore, 'id' | 'category'>;
  error: string | null;
  route: string | null;
  tools: string[];
  answer: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface ResultFile {
  schemaVersion: 1;
  runAt: string;
  gitSha: string;
  datasetSha256: string;
  provider: Provider;
  models: { cheap: string; strong: string };
  summary: ResultSummary;
  cases: ResultCase[];
}

export function buildResult(input: {
  runAt: Date;
  gitSha: string;
  datasetSha256: string;
  provider: Provider;
  cases: EvalCase[];
  runs: CaseRun[];
}): ResultFile {
  const { cases, runs, provider } = input;
  const scores = cases.map((c, i) => scoreCase(c, runs[i]));
  const sumCost = runs.reduce<number | null>(
    (sum, run) =>
      sum === null || run.costUsd === null ? null : sum + run.costUsd,
    0,
  );
  return {
    schemaVersion: 1,
    runAt: input.runAt.toISOString(),
    gitSha: input.gitSha,
    datasetSha256: input.datasetSha256,
    provider,
    models: MODEL_IDS[provider],
    summary: {
      ...summarize(scores),
      errors: runs.filter((run) => run.error !== null).length,
      inputTokens: runs.reduce((n, run) => n + run.inputTokens, 0),
      outputTokens: runs.reduce((n, run) => n + run.outputTokens, 0),
      cachedTokens: runs.reduce((n, run) => n + run.cachedTokens, 0),
      costUsd: sumCost,
    },
    cases: scores.map(({ id, category, ...flags }, i) => ({
      id,
      category,
      scores: flags,
      error: runs[i].error,
      route: runs[i].route,
      tools: runs[i].toolCalls.map((call) => call.name),
      answer: runs[i].answer,
      events: runs[i].events,
      inputTokens: runs[i].inputTokens,
      outputTokens: runs[i].outputTokens,
      cachedTokens: runs[i].cachedTokens,
      costUsd: runs[i].costUsd,
      latencyMs: runs[i].latencyMs,
    })),
  };
}

/** `<UTC timestamp>-<provider>.json`, with `:` replaced so the name is valid on Windows. */
export const resultFileName = (
  result: Pick<ResultFile, 'runAt' | 'provider'>,
) => `${result.runAt.replaceAll(':', '-')}-${result.provider}.json`;

export async function writeResult(
  dir: string,
  result: ResultFile,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, resultFileName(result));
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return path;
}

export function readGitSha(): string {
  try {
    return (
      execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

const percent = (rate: {
  passed: number;
  total: number;
  rate: number | null;
}) =>
  rate.rate === null
    ? '  n/a'
    : `${(rate.rate * 100).toFixed(0).padStart(3)}% (${rate.passed}/${rate.total})`;

export function formatSummary(result: ResultFile): string {
  const { summary } = result;
  const lines = [
    `provider ${result.provider} (${result.models.cheap} / ${result.models.strong})`,
    `cases ${summary.cases}, errors ${summary.errors}, all metrics pass ${percent(summary.pass)}`,
    ...METRIC_NAMES.map(
      (name) => `  ${name.padEnd(11)} ${percent(summary.metrics[name])}`,
    ),
    ...Object.entries(summary.byCategory)
      .filter(([, rates]) => rates.cases > 0)
      .map(
        ([category, rates]) =>
          `  ${category.padEnd(12)} ${rates.cases} cases, pass ${percent(rates.pass)}`,
      ),
    `tokens in ${summary.inputTokens} (cached ${summary.cachedTokens}), out ${summary.outputTokens}, estimated cost ${summary.costUsd === null ? 'n/a' : `$${summary.costUsd.toFixed(4)}`}`,
  ];
  return lines.join('\n');
}

/** Runs the selected cases against one provider and writes a results file; returns its path. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const options = parseCliArgs(argv);
  requireCredentials(options.provider, env);
  const dataset = await loadDataset();
  const cases = selectCases(dataset.cases, options);
  const policies = new KeywordPolicySearch(
    await loadPolicyChunks(POLICIES_DIR),
  );
  const models = createEvalModels(options.provider, {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '',
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? '',
    AWS_REGION: env.AWS_REGION || undefined,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || undefined,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || undefined,
  });

  const runAt = new Date();
  const runs = await runCases(cases, { models, policies }, (run, i) =>
    console.log(
      `[${i + 1}/${cases.length}] ${run.id}${run.error ? ` error: ${run.error}` : ''}`,
    ),
  );
  const result = buildResult({
    runAt,
    gitSha: readGitSha(),
    datasetSha256: dataset.sha256,
    provider: options.provider,
    cases,
    runs,
  });
  const path = await writeResult(RESULTS_DIR, result);
  console.log(`\n${formatSummary(result)}\n\nResults written to ${path}`);
  return path;
}

// Runs only when started directly (`npm run eval`), not when a spec imports this module.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof CliError ? error.message : error);
    process.exitCode = 1;
  });
}
