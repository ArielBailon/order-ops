# Feature: PR CI pipeline

**From build-plan:** feature 9c
**Build attempt:** 1
**Branch:** feature/pr-ci-pipeline
**Status:** verified

## Goal

Every pull request runs the project's real checks in GitHub Actions and shows one clear pass or fail: lint, typecheck of all three apps and the spec files, unit tests, e2e tests, a Prisma migration check against a real pgvector Postgres, the existing keyless eval gate, and a Docker build of all four image targets. Nothing here deploys, pushes an image or touches AWS (that is 9d).

## In scope

- `.github/workflows/ci.yml`, triggered on `pull_request` only, with `permissions: contents: read`, a per-PR `concurrency` group that cancels older runs, and three jobs:
  - `checks`: checkout, Node 24 with the npm cache, `npx -y npm@11 ci` (Node's bundled npm crashes on this project), `npx prisma generate` with a placeholder `DATABASE_URL` (the same pattern `evals.yml` uses), then `npm run lint`, `npx tsc -p apps/<app>/tsconfig.app.json --noEmit` for `orderops-agent`, `orders-service` and `customers-service`, `npm run typecheck:spec`, and `npm test`.
  - `integration`: a `pgvector/pgvector:pg16` service container with a health check, `npx prisma migrate deploy`, a schema-drift check that fails when `prisma/schema.prisma` has changes no migration covers (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`), then `npm run test:e2e` with `DATABASE_URL`, `JWT_SECRET` and the other variables the e2e specs read set to throwaway values (no real provider keys).
  - `docker`: a matrix building the three runtime targets (`--build-arg APP=<app> --target runtime`) and the `tools` target from the existing `Dockerfile`, without pushing.
- The eval gate stays where it is: the `deterministic` job in `.github/workflows/evals.yml` already runs the eval specs and `npm run eval:regress` on every pull request with no secrets. This feature does not copy those steps into `ci.yml`; it verifies that job runs on the PR and documents it as one of the checks to require.
- Short pointers in `AGENTS.md` (Commands: the PR checks and the exact local commands each job runs) and a CI line in `README.md`, including that requiring the checks is a GitHub repository setting the owner turns on.

## Out of scope

- CD: OIDC to AWS, ECR, commit-SHA image tags, deploy over SSM, migrate on the host, smoke test, rollback, concurrency guard for deploys and the protected production environment (all 9d). No push of images and no AWS access from CI.
- A combined `Verify` npm script and a `verify.yml` (the `/ci` skill owns that), coverage reports, browser tests, dependency or secret scanning, a Node version matrix, and caching Docker layers.
- Changing the eval harness, its dataset or `evals.yml` behavior; live eval runs stay manual and weekly.
- Repository branch protection or required status checks: a remote GitHub setting the owner makes; the docs say how.
- Fixing the existing noisy log line `this.chat.flushTraces is not a function` printed at the end of `approvals.e2e-spec.ts` (the suite passes; a test mock gap).

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement all steps in order, one reviewable packet at the end, no per-step approval pauses and no checkpoint commits. Steps 1-4 are repository changes. The live proof below is not a build step, because a pull request needs a pushed commit and the spec must stay unchanged after the independent review; it runs after the review checkpoint and never starts without an explicit yes from the user for each push and each pull request. `/complete` creates the final feature commit.

## Build steps

- [x] 1. `checks` job. Create `.github/workflows/ci.yml` with the trigger, permissions, concurrency and the `checks` job above. Done when: the file parses as YAML (with a YAML parser already present in `node_modules`, or `actionlint` when installed), and every command listed in the job passes locally from a clean `npm ci`-equivalent state in one run (lint, three app typechecks, `typecheck:spec`, `npm test`), with the observed counts recorded.
- [x] 2. `integration` job. Add the pgvector service container, `migrate deploy`, the drift check and the e2e run. Done when: the file still parses; `npm run test:e2e` passes locally with the same environment values the job sets; the exact drift-check flags are confirmed against `npx prisma migrate diff --help` (the options listed there include `--from-config-datasource`, `--to-schema` and an exit-code option: confirm its name and meaning before using it); and the job lists no real provider key.
- [x] 3. `docker` job. Add the four-target matrix. Done when: the file parses and each matrix entry names a target that exists in the `Dockerfile` (`runtime` with `APP` set to each of the three apps, and `tools`). A local `docker build` is not required when Docker is not running; the real build is observed in the live proof.
- [x] 4. Docs. Add the `AGENTS.md` Commands entry and the `README.md` CI line. Done when: both name the workflow file, the four checks (`checks`, `integration`, `docker`, and the `deterministic` eval job), and that required checks are set in GitHub repository settings; `git diff` outside the workflow file touches only those two files.
- [x] 5. Repair review finding F-17 (comments only). Reword the `ci.yml` header comment and add a comment above the e2e step so they say the e2e specs use fakes and the pgvector container backs the migration and drift checks. Done when: the workflow still parses as YAML and `git diff` shows only comment lines changed in `.github/workflows/ci.yml`. The 9c plan line wording is the owner's to change.

## Live proof (after the review checkpoint, approval gated)

Not a checklist step: the result is recorded in the final review packet, not in this spec. With the user's yes for each action: push `master` if it is not yet on `origin`, push the feature branch, open a pull request into `master`. Done when, observed: all `ci.yml` jobs (`checks`, `integration`, and the four `docker` matrix entries) and the `deterministic` eval job are green on that PR; then, on a scratch branch (never merged, deleted afterwards) a deliberate drift (a `schema.prisma` change without a migration) makes the `integration` job fail at the drift check, proving the gate bites. If a job fails for a real reason, fix the workflow as a new build step, take a new review checkpoint, and re-run; do not report the proof as done on a partial result.

## Files / areas

- New: `.github/workflows/ci.yml`.
- Changed: `AGENTS.md` (Commands), `README.md` (one CI line).
- Untouched: `.github/workflows/evals.yml`, `Dockerfile`, compose files, application code, Prisma schema and migrations, `package.json`.

## Data / contracts

- Trigger: `pull_request` (no `push`, no `pull_request_target`, so forked PRs run with no secrets and read-only token). `permissions: contents: read` at workflow level.
- Job names `checks`, `integration`, `docker` are the status-check names the owner can require; keep them stable. The existing eval job's check name stays as it is.
- No repository secrets are used. The Postgres service uses a throwaway password and its port is published only to the runner's localhost (the job runs on the runner, not in a container); `JWT_SECRET` and other required variables in the job are test values of the required shape (32+ characters).
- Pinned actions by major tag, matching `evals.yml` (`actions/checkout@v4`, `actions/setup-node@v4`), and Docker builds with the preinstalled Docker on `ubuntu-latest`, adding no new action dependency unless a step needs one.
- Failure semantics: any failing command fails its job; the drift check's non-zero exit fails `integration`.

## Testing

- No application logic changes, so no new Vitest tests. Step 1 and 2 run the real commands locally; the live proof is the real CI proof and records the real run results. Nothing claims a CI run that was not observed.
- Expect `npm test` to report 41 files and 343 tests and `npm run test:e2e` 5 files and 40 tests at the time of writing; record what is actually observed.

## Notes for the AI

- Never push, open a pull request, or change repository settings without the user's explicit yes for that action in the current chat. Read-only `git` and `gh` calls are fine. The local `master` is ahead of `origin/master` by several commits; the live proof needs the user's decision on pushing it first.
- The e2e specs use fakes and in-memory stores and passed locally with no database, so the pgvector container today serves the migration and drift checks; it is still wired into the e2e step so a future database-backed e2e runs unchanged. Do not claim e2e coverage of the database.
- Decision recorded: a new `ci.yml` instead of editing `evals.yml`, so the eval workflow keeps one purpose (PR gate plus the manual and weekly live run) and no eval step is duplicated. The reviewer or owner can ask to merge them later; the job names stay the same either way.
- Reuse the install pattern from `evals.yml` verbatim (`actions/setup-node@v4` with Node 24 and npm cache, `npx -y npm@11 ci`, `npx prisma generate` with the placeholder `DATABASE_URL`).
- Keep the workflow small: no matrices beyond the Docker targets, no reusable workflows, no composite actions.

## Open questions

- None blocking. Reversible choices recorded above: separate `ci.yml`, pull-request trigger only, and Docker targets built but not pushed.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":9486,"specSha256":"90a31a4e2957dd89c9477d940547dc9c5bed69135cb895277b90d093417528a5","branch":"refs/heads/feature/pr-ci-pipeline","head":"2d7311400059ad7a7c6c0a409a9ab75ad248cf08","baseRef":"refs/heads/master","baseCommit":"00557c9a6527ba19982a54b8d09408430eb3a313","sourceTree":"050fe5fcf0c870bb157a43ee9645311074fc169c","absentOptional":[]} -->

## Findings

### 9c/F-17 [P3] closed - The e2e step never touches the pgvector service it runs next to

**File:** .github/workflows/ci.yml:79
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: tests)
**Why it matters:** Every e2e spec sets its own `DATABASE_URL` (`postgresql://e2e:e2e@127.0.0.1:5432/e2e` or `postgresql://unused`) and overrides the checkpointer, trace, refund, memory, embeddings and policy providers with fakes, so `npm run test:e2e` never connects to the service container. The database only serves the migrate and drift steps. The build plan (9c) and the spec describe "e2e against a pgvector service container", which overstates what the job proves (the e2e would pass identically without the service). The drift check itself is correct and valuable; the defect is the claim, not the gate.
**Suggested fix:** Reword the 9c line and the `ci.yml` comment to say the container backs the migration and drift checks, and the e2e specs run against in-memory fakes. Nothing is lost.
**Resolution:** The `ci.yml` header comment and a comment above the e2e step now say the e2e specs use fakes and do not touch the service container, which backs the migration and drift checks. The 9c plan and overview line is user-owned and unchanged; suggested wording is in the final packet.
Re-reviewed 2026-10-20 by /audit independent current: ci.yml header (lines 3-8) and the comment above the e2e step (lines 77-78) now state the e2e specs use fakes and the service container backs the migrate and drift checks; this matches the e2e specs, which set their own DATABASE_URL and fake the stores. Original defect gone, no new one introduced; closed.

## Independent review

**Status:** passed
**Target commit:** 2d7311400059ad7a7c6c0a409a9ab75ad248cf08
**Base commit:** 00557c9a6527ba19982a54b8d09408430eb3a313
**Base ref:** master
**Spec hash:** 90a31a4e2957dd89c9477d940547dc9c5bed69135cb895277b90d093417528a5
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-20T16:51:52Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-20T17:10:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

## Commands

- `git rev-parse HEAD`, `git merge-base master HEAD`, `sha256sum blueprint/context/current-feature.md`, `git status --porcelain`: pass (HEAD, base and spec hash match the request; only review.md and findings.md differ)
- `git diff 00557c9..2d73114` (stat and per-file): pass
- Static checks of ci.yml against package.json scripts, tsconfig paths, Dockerfile targets and args, evals.yml triggers, Prisma config, schema and migrations: pass
- No lint, test, build or network command run; actionlint and Docker are not available to the reviewer: unavailable

## Evidence

- ci.yml uses only `pull_request`, `permissions: contents: read`, no secrets, no `pull_request_target`, a per-PR concurrency group, `actions/*@v4` major tags matching evals.yml, and job timeouts of 15, 15 and 20 minutes.
- The only `${{ }}` in a run step is routed through the `IMAGE` env var from a fixed matrix; no injection path.
- Every command exists: `lint`, `typecheck:spec`, `test`, `test:e2e` in package.json; three `apps/*/tsconfig.app.json` and `prisma/schema.prisma` exist; Dockerfile has `tools` and `runtime` targets and the `APP` arg.
- evals.yml `deterministic` job runs on `pull_request`, so ci.yml correctly omits the eval gate.
- Drift check: `prisma7.config.ts` supplies the datasource URL from `DATABASE_URL`, so `--from-config-datasource` reads the migrated database. Migrations contain no `policy_chunks`, checkpoint tables or extensions, so a freshly migrated database has no library-managed tables and the diff cannot false-fail on them.
- Postgres service has a pg_isready health check, retries and a 5432 mapping matching `DATABASE_URL`; the e2e specs set their own env, so the e2e step needs nothing more.
- AGENTS.md and README.md pointers match the workflow job names and commands.
- F-17 re-reviewed against ci.yml lines 3-8 and 77-78 and closed.

## Findings

- F-17 closed. No new findings. F-06, F-08, F-15 and F-16 are outside this delta and untouched.

## Remaining risk

- Owner-reported, not verifiable from the repository: an earlier review of the previous checkpoint passed, a live pull request run had all checks green (checks, integration, four docker matrix entries, eval deterministic), and a scratch-branch run showed integration failing on deliberate schema drift.
- Unavailable here: actionlint, Docker builds, and local lint, test and e2e runs were not executed by the reviewer.
- Actions are pinned by major tag, not commit SHA (matches evals.yml and the spec's decision).
- Build plan 9c and the overview still say "e2e against a pgvector service container", user-owned wording already noted in F-17.
