# Feature: CD on main

**From build-plan:** feature 9d
**Build attempt:** 1
**Branch:** feature/cd-on-main
**Status:** verified

## Goal

Every push to `master` builds the three app images and the `tools` image, pushes them to ECR tagged with the commit SHA, deploys that SHA to the production EC2 instance over SSM, runs the migrations, proves the release with `/health` and one real chat request, and rolls back to the previous SHA automatically if the deploy or the smoke test fails. AWS access is by GitHub OIDC only (no long-lived keys), only one deploy runs at a time, and the deploy job sits behind a protected `production` environment.

## In scope

- `.github/workflows/deploy.yml`
  - Triggers: `push` to `master` (with `paths-ignore` for `blueprint/**`, `docs/**`, `**.md`, `evals/results/**`) and `workflow_dispatch`. The default branch is `master`; the build-plan wording "main" means it.
  - Workflow `permissions: contents: read`; jobs that call AWS add `id-token: write`. `concurrency: { group: deploy-production, cancel-in-progress: false }` so a second push queues behind a running deploy instead of cancelling it.
  - Job `build`: assume the AWS role by OIDC (`aws-actions/configure-aws-credentials`), log in to ECR (`aws-actions/amazon-ecr-login`), build `orderops-agent`, `orders-service`, `customers-service` (`--target runtime --build-arg APP=<app>`) and `tools` from the existing `Dockerfile` for `linux/amd64` (the instance is `t3.small`), tag each `<registry>/<name>:<full commit SHA>` and push. A tag that already exists in ECR is skipped (checked with `aws ecr describe-images`), so re-running a workflow for the same SHA is safe.
  - Job `deploy` (`needs: build`, `environment: production`): send one SSM `AWS-RunShellScript` command to the instance that runs `deploy/deploy.sh <sha>`, wait for it, and fail the job on a non-zero result. It prints the previous SHA the script reports.
  - Smoke step (after `deploy`): `deploy/smoke.sh` against `https://api.arielbailon.dev`.
  - Rollback step (runs only when the deploy or smoke step failed and a previous SHA was reported): an SSM command running `deploy/deploy.sh <previous-sha> --no-rollback`, then `deploy/smoke.sh` again. The job still ends red so the failed release is visible.
- `deploy/deploy.sh <sha> [--no-rollback]`, run on the instance as `ec2-user` (the SSM command uses `sudo -u ec2-user`), in `~/order-ops`:
  1. Reads the current `TAG` from `.env.production` as the previous SHA and prints `PREVIOUS_TAG=<value>`.
  2. `git fetch` and `git checkout --detach <sha>` so the compose files and `Caddyfile` match the images. A failed checkout changes nothing.
  3. Logs in to ECR with `aws ecr get-login-password` using the instance role, and pulls the four images for `<sha>`. A failed pull changes nothing (the old containers keep running).
  4. Writes `REGISTRY` and `TAG=<sha>` into `.env.production`, then `docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production up -d --remove-orphans --wait --wait-timeout 180` (migrate runs first by `depends_on`; `--wait` fails on an unhealthy or exited service).
  5. If step 4 fails and the previous tag is a real SHA (not `local`) and `--no-rollback` was not given, redeploys the previous SHA the same way, then exits non-zero. If the previous tag is `local` (the first CD deploy), it says so and exits non-zero without a rollback.
  6. Prunes dangling images (`docker image prune -f`) so the 30 GB disk does not fill; it does not prune tagged images.
- `deploy/smoke.sh <base-url>`: `GET /health` must return `{"status":"ok"}`; `POST /auth/login` with `SMOKE_EMAIL` and `SMOKE_PASSWORD` from the environment must return an `accessToken`; `POST /chat` with a short fixed message must return HTTP 200 and an SSE stream containing a `final` event. Retries `/health` for up to 60 s (Caddy and the gateway may still be warming up). Prints which check failed and never prints the token or password. Usable from CI and by hand.
- Smoke login: a one-off compose job `smoke-user` (profile `jobs`, like `seed`) running `prisma/smoke-user.ts`, which upserts one customer (`id` `cus_smoke`, no orders, tier `standard`, role `customer`) from `SMOKE_EMAIL` and `SMOKE_PASSWORD` in the environment, hashing with the existing `hashPassword`. It refuses a missing variable or a password under 16 characters, and is idempotent (rerun rotates the password). The password exists only as a GitHub `production` environment secret and typed on the server; never in the repo.
- Docs: `docs/deploy.md` gets a "Continuous deployment" section and loses the "manual until 9c" and "CI/CD is 9c" wording; `AGENTS.md` Commands and `README.md` get short pointers. The section holds the exact AWS CLI command groups, each marked with what it creates and costs, and stays within the existing "Who runs what" rule (the user's explicit yes per command group):
  - Four ECR repositories (`orderops/orderops-agent`, `.../orders-service`, `.../customers-service`, `.../tools`) with immutable tags and a lifecycle policy keeping the last 10 images.
  - The GitHub OIDC identity provider (`token.actions.githubusercontent.com`) and a `orderops-github-deploy` role whose trust policy allows only `repo:ArielBailon/order-ops:environment:production` with audience `sts.amazonaws.com`. Its permissions: ECR push/describe on those four repositories plus `ecr:GetAuthorizationToken`, and `ssm:SendCommand` on `AWS-RunShellScript` and the one instance, `ssm:GetCommandInvocation`.
  - An inline policy on the existing `orderops-ec2` instance role for ECR pull on those four repositories (and `ecr:GetAuthorizationToken`).
  - The GitHub side, done by the owner in repository settings: a `production` environment with required reviewers and deployment branches limited to `master`; environment variables `AWS_ROLE_ARN`, `INSTANCE_ID`, `AWS_REGION`, `SMOKE_EMAIL`; environment secret `SMOKE_PASSWORD`.
  - Creating the smoke user on the instance, the first-deploy bridge (the host currently runs `TAG=local` images built on the instance, so the first CD deploy has no rollback target; the docs say to expect that), how to roll back by hand (`deploy/deploy.sh <sha>`), and that migrations are not reverted by a rollback, so migrations must stay backward compatible with the previous release.

## Out of scope

- Branch protection or required status checks (a GitHub setting; PR CI from 9c is the gate, and this workflow does not rerun lint, tests or evals).
- Reverting database migrations on rollback, blue/green or zero-downtime deploys (a brief restart of the stack is accepted for the demo), multiple environments or instances, ECS/Fargate.
- Rate limiting, spend caps and demo credentials for the public (item 12); the smoke user's spend is one short chat per deploy.
- Observability endpoints, the console, Langfuse (items 10-11); application code and the Prisma schema other than the new script.
- Slack or email notifications, image vulnerability scanning, Docker layer caching, SBOMs.
- Changing `docker-compose.prod.yml` or `Dockerfile` (their `REGISTRY` and `TAG` variables already support this); a change is made only if step 2's rehearsal proves one is needed, and is noted in the final report.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order and present one review packet at the end, with no per-step pauses and no checkpoint commits. Steps 1-4 are repository changes. Step 5 creates AWS resources and changes GitHub settings: it is approval gated (the user's explicit yes per command group) and runs after the review checkpoint, so the reviewed spec does not change. Do not push, deploy or create any AWS or GitHub resource without that yes.

## Build steps

- [x] 1. Smoke user job. Add `prisma/smoke-user.ts` and the `smoke-user` service in `docker-compose.prod.yml`, passing only `DATABASE_URL`/`JWT_SECRET` via `*db-env` plus `SMOKE_EMAIL` and `SMOKE_PASSWORD` (required with `:?`). Done when: against the local Postgres from `docker-compose.yml` (started with `docker compose up -d` and migrated) the script creates `cus_smoke`, a second run leaves exactly one row and updates the hash, a missing variable and a 15-character password each exit non-zero, and `POST /auth/login` with the smoke credentials returns an `accessToken` on a locally running gateway; `npx tsc` over the script (`npm run typecheck:spec` or the nearest existing config that includes `prisma/`) and `npm run lint` pass.
- [x] 2. Deploy and smoke scripts. Add `deploy/deploy.sh` and `deploy/smoke.sh` as specified, `set -euo pipefail`, executable bit set in git (`git update-index --chmod=+x`), same style as `deploy/backup.sh`. Done when: `bash -n` passes on both; `smoke.sh http://localhost:3000` passes against the locally running stack and fails with a named check when the password is wrong or the gateway is stopped; and `deploy.sh` is exercised with a stubbed `docker`, `git` and `aws` on `PATH` (a throwaway test harness outside the repo or in the scratchpad) covering: success, failed pull leaves `.env.production` untouched, failed `up` rolls back to the previous SHA and exits non-zero, `--no-rollback` skips it, previous tag `local` skips it. No real Docker pull or AWS call is made.
- [x] 3. Workflow. Add `.github/workflows/deploy.yml` as specified, with actions pinned by major tag like `ci.yml` and `evals.yml`. Done when: the file parses as YAML (parser already in `node_modules`, or `actionlint` if installed); the job graph, `needs`, `environment: production`, concurrency group, `id-token: write` only on AWS-calling jobs and the rollback `if:` condition are checked by reading; every `deploy/*.sh` path and `Dockerfile` target it names exists; and no secret or AWS value is hardcoded (account id, role ARN, instance id and region come from environment variables/`vars`).
- [x] 4. Docs. Write the `docs/deploy.md` section and wording fixes, the `AGENTS.md` Commands entry (workflow file, scripts, the smoke-user job, required GitHub settings) and the `README.md` line. Done when: every AWS command in the section uses `--region "$REGION"` and the variables defined in step 0 of the runbook, each command group states what it creates and its cost, the trust policy `sub` equals the exact `repo:ArielBailon/order-ops:environment:production` string, the role policies list only the resources named above, and `git diff` outside the new/changed files in this spec shows nothing else.
- [x] 5. Live proof (after the review checkpoint, approval gated). With the user's yes for each group: create the ECR repositories, OIDC provider, deploy role and instance-role policy; the user sets the GitHub environment, variables and secret; create the smoke user on the instance; push the branch, open a pull request and merge it into `master`. Done when, observed: the `deploy` workflow run is green with the reviewer approval shown, `https://api.arielbailon.dev/health` is ok, the running containers' images carry the new SHA (`docker compose ps` over SSM), and the smoke step's chat call returned a `final` event; then `deploy/deploy.sh` is run once over SSM with a SHA that has no image (the pull fails and the running version is unchanged) and once with the previous known-good SHA (a redeploy that proves the rollback path). The results go in the final report, not in this spec. **Result (partly proven):** Deploy #3 went green after approval (OIDC, ECR push, SSM deploy, smoke test); `/health` was ok and the three app containers ran the `ee736ec` images. A failed pull left `TAG` and the containers untouched, but it failed on the old compose bug and not on a missing image. Not exercised: a real rollback to a previous good release (only one good release existed). Two defects found live and fixed in follow-up PR #4 and the trust policy: the required `SMOKE_EMAIL` broke compose parsing on the host, and the OIDC subject carries owner and repo IDs.

## Files / areas

- New: `.github/workflows/deploy.yml`, `deploy/deploy.sh`, `deploy/smoke.sh`, `prisma/smoke-user.ts`.
- Changed: `docker-compose.prod.yml` (one `smoke-user` service), `docs/deploy.md`, `AGENTS.md` (Commands), `README.md`.
- Untouched: `Dockerfile`, `docker-compose.aws.yml`, `.github/workflows/ci.yml` and `evals.yml`, application code under `apps/` and `libs/`, Prisma schema and migrations.

## Data / contracts

- Image names: `<ECR registry>/orderops/<name>:<40-char commit SHA>` for `orderops-agent`, `orders-service`, `customers-service`, `tools`; on the host `REGISTRY=<account>.dkr.ecr.us-east-1.amazonaws.com/orderops` and `TAG=<sha>` in `.env.production` (the compose file already composes `${REGISTRY}/<name>:${TAG}`). `latest` is never pushed. Tags are immutable.
- `deploy.sh` exit codes: 0 deployed; non-zero failed (with or without a completed rollback). Its last stdout line is always `PREVIOUS_TAG=<value>` printed before any change, so the workflow can parse it from the SSM command output even on failure. It never prints `.env.production` contents.
- `smoke.sh` exit codes: 0 all checks passed; non-zero names the failing check (`health`, `login`, `chat`) on stderr. Reads `SMOKE_EMAIL` and `SMOKE_PASSWORD` from the environment only.
- Trust boundaries: the OIDC role is assumable only from the `production` environment of this repository; the instance accepts commands only through SSM (no new inbound port); the deploy role can run commands only on the one instance and push only to the four repositories; no AWS access key exists in GitHub or on the host. Git checkout on the host is by full SHA from the workflow, not a branch name. The SHA is validated as 40 hex characters in `deploy.sh` before use, because it reaches a shell on the host.
- Smoke user: stored in the production `Customer` table with a bcrypt/scrypt hash from `hashPassword` (whatever it uses today); the plaintext lives only in the GitHub environment secret and the operator's terminal. It has no orders, so it cannot read customer data.
- Failure semantics: build failure stops before any deploy; deploy failure triggers the script-level rollback; a smoke failure triggers the workflow-level rollback and a second smoke run; in every failure case the workflow ends red.

## Testing

- Step 1 runs the new script against local Postgres and exercises login. `npm run lint` and the relevant typecheck pass (`npm run typecheck:spec` covers specs; the script is checked with `tsc` using the config that includes it, noted in the final report).
- Step 2 uses a stubbed-command harness for `deploy.sh` and a real local stack for `smoke.sh`. No Vitest spec is added: the logic is shell around external commands and the stub harness is the proportionate check.
- Run `npm test` and `npm run test:e2e` once at the end to confirm nothing else changed; run `npm run lint`.
- The workflow cannot run locally: YAML validity and static review are the only pre-merge evidence. The live behavior (OIDC, ECR push, SSM deploy, real rollback) is proven only in step 5, and the final report must say which parts were and were not observed.

## Notes for the AI

- Repository default branch is `master`; match the existing action versions and style in `ci.yml` and `evals.yml`. Node 24 and `npx -y npm@11` are only needed if a job runs npm (the `build` job does not).
- The instance is x86_64; build on `ubuntu-latest` without QEMU or buildx platform flags.
- `docker-compose.prod.yml` `migrate` already runs before the apps; do not add a second migrate step. Do not run `ingest` or `seed` from CD.
- Never commit, push, deploy, or create AWS or GitHub resources without the user's explicit yes for that action. Add no AI attribution to commits (see `AGENTS.md`).
- Do not weaken `docs/deploy.md` section 11: the demo customers are still removed; the smoke customer is the only login that stays until item 12 decides demo credentials.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":15877,"specSha256":"1417870a5428a0949ebfd952bf360c852b443704d07c11ffa6dcf5ed1d073694","branch":"refs/heads/feature/cd-on-main","head":"ee736ec49f97b69a96992d9e0530082b6237d12e","baseRef":"refs/heads/master","baseCommit":"ee736ec49f97b69a96992d9e0530082b6237d12e","sourceTree":"c3499109e0d1f9f8deb38bd99a11c763a3ab5c10","absentOptional":[]} -->

## Completion note

The code was merged on GitHub (PR #3 `feature/cd-on-main`, and PR #4 `fix/smoke-user-compose-vars` for a defect found during the first live deploy) and deployed before `/complete` ran, so this completion is a documentation-only commit on `master`. No independent review receipt exists: the project policy was set to `manual` by the owner before completion, and a builder-session security audit (path scope, 2026-10-22) recorded F-17 to F-20 (P3) in the findings ledger, which stay open for later work.
