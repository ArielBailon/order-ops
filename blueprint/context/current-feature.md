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
