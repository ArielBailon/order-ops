import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ResultFile } from './cli.js';
import { readResults } from './compare.js';

const RESULTS_DIR = fileURLToPath(
  new URL('../../../../evals/results', import.meta.url),
);

/** A fall in the pass rate beyond this fraction fails the check; one run is only a sample. */
export const DEFAULT_TOLERANCE = 0.1;

export interface RegressionReport {
  provider: string;
  /** False only when the pass rate over the shared cases fell by more than the tolerance. */
  ok: boolean;
  message: string;
}

type ResultCase = ResultFile['cases'][number];

/** Answer quality counts only when both runs were judged, so a judged run is not held to more. */
function passed(c: ResultCase, withQuality: boolean): boolean {
  const { route, tools, trajectory, guardrail, answerQuality } = c.scores;
  return (
    route &&
    tools &&
    trajectory &&
    guardrail !== false &&
    (!withQuality || answerQuality !== false)
  );
}

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/**
 * Compares two runs of one provider on the same dataset. Only cases present in both and
 * without a run error on either side count; cases that passed before and fail now are listed.
 */
export function checkRegression(
  previous: ResultFile,
  latest: ResultFile,
  tolerance: number = DEFAULT_TOLERANCE,
): RegressionReport {
  const { provider } = latest;
  const withQuality = Boolean(previous.judge && latest.judge);
  const before = new Map(previous.cases.map((c) => [c.id, c]));
  const shared = latest.cases.flatMap((now) => {
    const was = before.get(now.id);
    return was && was.error === null && now.error === null
      ? [
          {
            id: now.id,
            was: passed(was, withQuality),
            now: passed(now, withQuality),
          },
        ]
      : [];
  });
  if (shared.length === 0)
    return {
      provider,
      ok: true,
      message: `${provider}: no shared cases without errors to compare, skipped.`,
    };

  const rate = (key: 'was' | 'now') =>
    shared.filter((c) => c[key]).length / shared.length;
  const drop = rate('was') - rate('now');
  const regressed = shared.filter((c) => c.was && !c.now).map((c) => c.id);
  const ok = drop <= tolerance;
  const lines = [
    `${provider}: pass rate ${percent(rate('was'))} -> ${percent(rate('now'))} over ${shared.length} shared cases (${ok ? 'within' : 'beyond'} the ${percent(tolerance)} tolerance)`,
    ...(regressed.length
      ? [`  passed before, fail now: ${regressed.join(', ')}`]
      : []),
  ];
  return { provider, ok, message: lines.join('\n') };
}

/** Per provider, the newest run against the newest earlier run on the same dataset. */
export function checkAll(
  results: ResultFile[],
  tolerance: number = DEFAULT_TOLERANCE,
): RegressionReport[] {
  const byProvider = new Map<string, ResultFile[]>();
  for (const result of results)
    byProvider.set(result.provider, [
      ...(byProvider.get(result.provider) ?? []),
      result,
    ]);

  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, runs]) => {
      const [latest, ...older] = runs.sort((a, b) =>
        b.runAt.localeCompare(a.runAt),
      );
      const previous = older.find(
        (run) => run.datasetSha256 === latest.datasetSha256,
      );
      return previous
        ? checkRegression(previous, latest, tolerance)
        : {
            provider,
            ok: true,
            message: `${provider}: no earlier run on this dataset version to compare with, skipped.`,
          };
    });
}

/** Returns the process exit code: 1 when any provider regressed beyond the tolerance. */
export async function main(
  argv: string[],
  dir: string = RESULTS_DIR,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { tolerance: { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}
Usage: npm run eval:regress [-- --tolerance 0.1]`);
    return 1;
  }
  const tolerance =
    values.tolerance === undefined
      ? DEFAULT_TOLERANCE
      : Number(values.tolerance);
  if (
    values.tolerance === '' ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 1
  ) {
    console.error('--tolerance must be a fraction between 0 and 1.');
    return 1;
  }

  const reports = checkAll(await readResults(dir), tolerance);
  console.log(
    reports.length
      ? reports.map((r) => r.message).join('\n')
      : 'No eval results to check, skipped.',
  );
  return reports.every((r) => r.ok) ? 0 : 1;
}

// Runs only when started directly (`npm run eval:regress`), not when a spec imports this module.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
