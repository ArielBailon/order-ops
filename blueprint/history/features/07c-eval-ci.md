# Feature: Eval CI

**From build-plan:** feature 7c
**Build attempt:** 1
**Status:** verified
**Branch:** feature/eval-ci

## Goal

Run the evals automatically on GitHub. Pull requests get a keyless, deterministic check, with no secrets and no cost. A manual or scheduled run gets a live-provider eval, capped in cases and estimated cost. Both compare against the last committed results, so a quality drop is caught.

## In scope

- **Cost cap in the eval CLI:** `--max-cost <usd>` stops running further cases once the estimated agent cost of the cases already run exceeds the cap. The result file records that the run was cut short (`truncated: true` plus the number of cases run) so a partial run is never mistaken for a full one. When a priced cost is unavailable (`costUsd` null) under a cap, the run stops, because the cap cannot be enforced. The cap covers agent calls only. Judge cost is bounded by the case count and is reported separately.
- **Regression check:** `npm run eval:regress` compares each provider's newest result file in `evals/results/` with that provider's previous result file with the same `datasetSha256`.
  - It lists the cases that passed before and now fail, and the change in overall pass rate over the case ids both runs share.
  - It exits 1 when the pass rate over the shared cases dropped by more than `--tolerance` (default 0.10, as a fraction).
  - It exits 0 with a one-line notice when there is no earlier comparable file (no results at all, a first run for the provider, or a different dataset hash).
  - Case-level regressions below the tolerance are reported but do not fail the run, because a single run is a sample.
- **`.github/workflows/evals.yml` with two jobs:**
  - `deterministic`: runs on `pull_request`. It installs dependencies, generates the Prisma client (with a placeholder `DATABASE_URL`, no database), then runs the eval specs (`npx vitest run apps/orderops-agent/src/evals`) and `npm run eval:regress`. It uses no secrets and no network model calls.
  - `live`: runs on `workflow_dispatch` and a weekly `schedule`. Inputs: `provider` (anthropic or openai, default anthropic), `limit` (case cap), `max_cost` (USD cap), `judge` (boolean). It runs `npm run eval` with those, then `npm run eval:regress` against the committed baseline, and uploads the new `evals/results/*.json` and `evals/COMPARISON.md` as a workflow artifact. It never commits or pushes: the user reviews the artifact and commits results by hand. Secrets come only from `secrets.ANTHROPIC_API_KEY` and `secrets.OPENAI_API_KEY`.
- Workflow permissions limited to `contents: read`. The workflow uses the project's real runtime: Node with `npx -y npm@11 ci`, because npm 10.9.3 crashes on this project's install.

## Out of scope

- Any other CI check: the project-wide `Verify` command and `verify.yml` stay with `/ci`. This workflow runs only the eval subset.
- Bedrock in CI (it needs AWS credentials and the deploy work in item 8).
- Auto-committing results, PR comments, dashboards, branch protection rules, and notifications.
- Changes to the dataset, the rubric, or the judge.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`. Build the steps in order, run each step's check, and stop for one review packet after the last step. `/complete` makes the single commit.

## Build steps

- [x] 1. Cost cap. Add `--max-cost` to `parseCliArgs` (positive number, `CliError` otherwise) and make `runCases` accept a stop check evaluated after each case. Record `truncated` and `casesRun` in the result file (additive, optional, schema stays version 1) and in `formatSummary`. **Done when:** `cli.spec.ts` and `run.spec.ts` cover flag validation, stopping after the case that crosses the cap with the remaining cases not run, a null cost stopping the run, no truncation fields without a cap or when the cap is not reached, and the existing assertions still pass (`npx vitest run apps/orderops-agent/src/evals` green).
- [x] 2. Regression check. Add `apps/orderops-agent/src/evals/regress.ts` (pure `checkRegression(previous, latest, tolerance)` plus a thin CLI that reads `evals/results/`, reusing `readResults` from `compare.ts`) and the `eval:regress` script in `package.json`. Compare only runs with the same `datasetSha256`, only over shared case ids, and skip errored cases on both sides rather than counting them as passes. **Done when:** `regress.spec.ts` covers a drop beyond the tolerance (exit 1), a drop within it (exit 0, regressed cases listed), an improvement, no results, a single file, a different dataset hash, partial (truncated or `--limit`) runs compared on shared ids, and errored cases; `npm run eval:regress` on the empty results folder prints the notice and exits 0.
- [x] 3. Workflow. Add `.github/workflows/evals.yml` with the two jobs above. Inputs reach commands through environment variables or validated `inputs`, never interpolated into shell text unquoted. `limit` and `max_cost` are checked as numbers before use. The `live` job fails early with a clear message when the needed secret is empty. **Done when:** the file parses as YAML with a parser available in the repository's dependencies (otherwise this check is reported as not run), every `npm run` command it uses exists in `package.json`, and a local run of the `deterministic` job's commands (`npx prisma generate` with a placeholder `DATABASE_URL`, the eval specs, `npm run eval:regress`) passes with `libs/prisma/src/generated` removed first and regenerated.
- [x] 4. Docs and final gate. Update the Evals entry under Commands in `AGENTS.md` (`--max-cost`, `eval:regress`, the workflow's two jobs, the required repo secrets, and that results from a live run are committed by hand). **Done when:** `npm test`, `npm run typecheck:spec`, `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`, `npm run lint` and `npx nest build orderops-agent` all pass. Not run, and reported as such: the workflow on GitHub itself, since that needs the branch pushed and, for the live job, secrets set in the repository.

## Files / areas

- New: `.github/workflows/evals.yml`, `apps/orderops-agent/src/evals/regress.ts`, `regress.spec.ts`.
- Changed: `evals/cli.ts`, `evals/run.ts` and their specs, `package.json` (script), `AGENTS.md` (Commands).
- Unchanged: dataset, rubric and judge, metrics, and everything outside `evals/` apart from the files above.

## Data / contracts

- Result files stay `schemaVersion: 1`. New optional fields: `truncated` (boolean) and `casesRun` (number) in the summary. Files without them read as complete runs.
- `eval:regress` result: exit code 0 or 1, with a plain-text report on stdout. It never writes files.
- The workflow is the only place secrets are read, as env vars on the single step that runs `npm run eval`, never echoed or passed to the PR job. The `pull_request` job gets no secrets by design: forked PRs would not receive them anyway, and untrusted code must not run next to API keys.
- Live runs spend money. The caps (`limit`, `max_cost`) are required inputs with defaults, and the scheduled run uses the defaults.

## Testing

Vitest specs with synthetic result files and fake models, no network. The workflow's behavior on GitHub is not verifiable here and is not claimed. No browser tests (API/CLI project).

## Notes for the AI

- Follow the surrounding eval code style: strict types, injected dependencies and temp dirs for specs, `CliError` for user errors.
- Reuse `readResults` and the result types; do not add dependencies. If no YAML parser is installed, don't add one just for a check: report the parse check as not run.
- Do not trigger the live job or call any provider from this work.

## Open questions

These defaults are reversible. Confirm or change them before implementing, since they set CI spend and noise:
- Schedule: weekly, Mondays 06:00 UTC, Anthropic only, no judge.
- Caps for the scheduled run: `limit` 41 (the full dataset) and `max_cost` 2.00 USD. A full run's cost is unknown until one is run, because no results exist yet.
- Regression tolerance: 0.10 on overall pass rate over shared cases.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":8113,"specSha256":"5b594cdf5cf98879511cc20b7a855f3f028eaf29ad8c769e7a9e200772aac769","branch":"refs/heads/feature/eval-ci","head":"726a4ed1bf226012bc7c497fa3342f3ecefff07d","baseRef":"refs/heads/master","baseCommit":"726a4ed1bf226012bc7c497fa3342f3ecefff07d","sourceTree":"ca8428bf84eff7eec8a80eb48a6245e6bdbe029a","absentOptional":[]} -->
