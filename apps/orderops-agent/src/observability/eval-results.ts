import { join } from 'node:path';
import type { ResultFile } from '../evals/cli.js';
import { latestPerProvider, readResults } from '../evals/results.js';

/** Where the committed eval results live: `/app/evals/results` in the image, the repo locally. */
export const EVAL_RESULTS_DIR = Symbol('EVAL_RESULTS_DIR');
export const defaultEvalResultsDir = () =>
  join(process.cwd(), 'evals', 'results');

export type EvalRunSummary = Omit<ResultFile, 'cases' | 'judge'> & {
  judge: ResultFile['judge'] | null;
  caseCount: number;
};

export interface LatestEvalsResponse {
  providers: EvalRunSummary[];
  /** True when every listed run used the same dataset, the rule `eval:compare` applies. */
  comparable: boolean;
}

/** The newest run per provider, without per-case data (which holds model answers). */
export async function latestEvals(dir: string): Promise<LatestEvalsResponse> {
  const providers = latestPerProvider(await readResults(dir)).map(
    ({ cases, judge, ...run }) => ({
      ...run,
      judge: judge ?? null,
      caseCount: cases.length,
    }),
  );
  return {
    providers,
    comparable: new Set(providers.map((p) => p.datasetSha256)).size <= 1,
  };
}
