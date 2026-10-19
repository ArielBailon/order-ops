# Feature: Containers and production compose

**From build-plan:** feature 9a
**Build attempt:** 1
**Status:** verified
**Branch:** feature/containers-and-production-compose

## Goal

Package the three Nest apps so one `docker compose` file can run the whole system the way it will run on the EC2 instance: apps, Postgres + pgvector, and Caddy terminating TLS. The result is proven locally with Docker. No AWS access is needed, and nothing is deployed in this feature.

## In scope

- One multi-stage `Dockerfile` that builds any of the three apps (`APP` build arg) and a `tools` target that runs the one-off jobs. Runtime images are non-root and carry production dependencies only.
- `.dockerignore`.
- `docker-compose.prod.yml` (the existing dev `docker-compose.yml` stays untouched): `postgres`, `orderops-agent` (gateway), `orders-service`, `customers-service`, `caddy`, plus one-off jobs under a `jobs` profile: `migrate`, `ingest`, `seed`.
- `Caddyfile` for the gateway, with automatic TLS for `API_DOMAIN` and SSE-safe proxying.
- `.env.production.example` with every variable the production compose reads.
- Production env validation: required variables fail fast at `docker compose` time; no AWS access keys are passed into containers.
- `GET /health` (liveness) and `GET /ready` (database reachable) on all three apps.
- A `HOST` bind setting for the two internal services (default stays `127.0.0.1`).
- Graceful shutdown: all three apps close cleanly on SIGTERM; the gateway ends open SSE streams with a final `error` event first.
- Short README and AGENTS.md Commands entries for the production compose.

## Out of scope

- AWS resources, IAM, DNS, CloudWatch (`awslogs` driver), S3 backups, `docs/deploy.md` (9b).
- GitHub Actions, ECR, image publishing, SSM deploy, rollback automation (9c).
- Choosing the instance CPU architecture (t4g is arm64, t3 is x86). Images are built for the builder's platform; 9b/9c decide.
- Observability endpoints, the demo console, rate limiting, demo-data reset (items 10-12).
- Pushing to origin or running anything on a remote host.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement all steps in order, one reviewable packet at the end, no per-step approval pauses and no checkpoint commits. `/complete` creates the final feature commit.

## Build steps

- [x] 1. Health endpoints and bind host. Add a `HealthController` to `libs/prisma` (registered by `PrismaModule`, so all three apps get it): `GET /health` returns 200 `{ "status": "ok" }` without touching the database; `GET /ready` runs `SELECT 1` through `PrismaService` with a 3 s timeout and returns 200 `{ "status": "ok" }` or 503 `{ "status": "unavailable" }` with no error detail. Both are unauthenticated. Add an optional `HOST` env value (default `127.0.0.1`) to `apps/orders-service/src/env.ts` and `apps/customers-service/src/env.ts` and use it in both `main.ts` files; call `enableShutdownHooks()` in both. Done when: new unit tests for the controller (ok, DB failure, DB timeout) and the `HOST` default pass with `npm test`, and `npx tsc -p apps/<app>/tsconfig.app.json --noEmit` passes for all three apps.
- [x] 2. Gateway SSE shutdown. Add a small provider that tracks open `/chat` streams (the only SSE endpoint; operator decisions return JSON), and a `beforeApplicationShutdown` hook that aborts each stream's `AbortController`, writes an SSE `error` event with new code `shutting_down` (message: the assistant is restarting, retry the same message), and ends the response. Add `shutting_down` to `ChatErrorCode` and its message map in `apps/orderops-agent/src/chat/chat.schemas.ts`. Streams unregister on close. Done when: a unit test with fake responses shows every open stream receives the event and ends, closed streams are not written to, and `npm test` plus the gateway typecheck pass.
- [x] 3. Dockerfile and `.dockerignore`. Stages: `deps` (`npm ci`, all dependencies), `build` (`npx prisma generate`, `npx nest build $APP`), `prod-deps` (`npm ci --omit=dev`), `runtime` (non-root `node` user, `NODE_ENV=production`, copies `dist/apps/$APP` and prod `node_modules`, starts `node dist/apps/$APP/main`, `EXPOSE` the app's port), and `tools` (full dependencies, `prisma/`, `prisma7.config.ts`, `libs/`, `apps/`, for migrate/ingest/seed). Base image `node:24-bookworm-slim` (matches CI's Node 24). Done when: `docker build --build-arg APP=<app> --target runtime` succeeds for all three apps, `docker run` of each image with the required env and a reachable Postgres answers `/health` with 200 as a non-root user, and the `tools` target builds.
- [x] 4. Production compose, Caddyfile and env template. In `docker-compose.prod.yml`: `postgres` (pgvector image, volume, healthcheck, password from `POSTGRES_PASSWORD`, no published port); the three apps built from the Dockerfile with `HOST=0.0.0.0`, `DATABASE_URL` assembled from `POSTGRES_PASSWORD`, service URLs set to the compose service names, container healthchecks on `/ready`, `depends_on` with `service_healthy`, `restart: unless-stopped`, `init: true`, `stop_grace_period: 30s`, image names overridable by `REGISTRY` and `TAG`; `caddy` (official image, only service publishing ports, 80 and 443, with a persistent data volume) proxying to the gateway with `flush_interval -1`. Required variables use `${VAR:?message}`: `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `API_DOMAIN`. `AWS_REGION` is optional and passed through; `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are never passed to containers. `.env.production.example` documents every variable and that `POSTGRES_PASSWORD` must be URL-safe. Done when: `docker compose -f docker-compose.prod.yml config` fails with a clear message when a required variable is missing and succeeds with an example env; `up -d` with `API_DOMAIN=localhost` brings all services healthy; only Caddy's ports are published (`docker compose ps`); `https://localhost/health` (with `-k`) returns 200.
- [x] 5. One-off jobs and end-to-end proof. Add `migrate` (`prisma migrate deploy`), `ingest` (`tsx` on the ingest script, because the npm script reads a `.env` file the container lacks) and `seed` (`prisma db seed`) services using the `tools` target. `migrate` is a one-shot service that the three apps wait on (`service_completed_successfully`), because the gateway creates its checkpoint tables at startup and `migrate deploy` then fails with P3005 on the non-empty database; `ingest` and `seed` sit under the `jobs` profile and run only with `docker compose run --rm`. Done when, against the local stack: `run --rm migrate` applies migrations and a second run is a no-op; `run --rm ingest` ingests the policy chunks (uses the real `OPENAI_API_KEY` from your `.env`, a few cents of embeddings); `run --rm seed` creates the demo customers; a login plus a `POST /chat` through Caddy streams SSE events ending in `final`; `docker compose stop orderops-agent` during an open stream delivers the `shutting_down` error event and the container exits promptly with 143 (SIGTERM, which Nest re-raises after its shutdown hooks) instead of being killed at the grace period (137).
- [x] 6. Docs. Add a short "Production compose (local rehearsal)" section to `README.md` and the production compose and jobs commands to the Commands section of `AGENTS.md`, written from what steps 3-5 actually ran. Done when: following the README section from a clean checkout reproduces step 5's results, and links and commands in the text match the files.

## Files / areas

- New: `Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `Caddyfile`, `.env.production.example`, `libs/prisma/src/health.controller.ts` (+ spec), a stream-tracking provider and spec in `apps/orderops-agent/src/chat/`.
- Changed: `libs/prisma/src/prisma.module.ts` and `index.ts`, `apps/orders-service/src/{env,main}.ts`, `apps/customers-service/src/{env,main}.ts`, `apps/orderops-agent/src/chat/{chat.controller,chat.schemas,chat.module}.ts` and the operator-resume controller under `apps/orderops-agent/src/approvals/`, `README.md`, `AGENTS.md`.
- Untouched: `docker-compose.yml` (dev), `.github/workflows/`, application logic, Prisma schema and migrations.

## Data / contracts

- `GET /health` -> 200 `{ "status": "ok" }`. `GET /ready` -> 200 `{ "status": "ok" }` or 503 `{ "status": "unavailable" }`. No auth, no detail, same on all three apps.
- New SSE error code `shutting_down`, sent as the standard `error` event shape `{ code, message }`, followed by the stream ending. The persisted thread is unaffected; a client retries the same message.
- New env values: `HOST` (internal services, default `127.0.0.1`); compose-level `POSTGRES_PASSWORD`, `API_DOMAIN`, `REGISTRY`, `TAG`. Application env schemas otherwise unchanged. App ports stay 3000/3001/3002.
- Network exposure: only Caddy publishes 80/443. Postgres, `orders-service` and `customers-service` are reachable only on the compose network. This keeps the existing rule that the internal services are not publicly reachable.
- Secrets live only in the compose env file on the host and are never baked into images.

## Testing

- Unit (Vitest, `npm test`): health controller, `HOST` default, SSE shutdown tracker. Typecheck all three apps, `npm run typecheck:spec`, and `npm run lint`.
- Container behavior has no automated test in this feature; it is proven by the commands in steps 3-5 and recorded in the review handoff. Image builds in CI belong to 9c.
- No browser tests (API-first project).

## Notes for the AI

- One parameterized `Dockerfile` replaces "a Dockerfile per app" from the plan to avoid three near-identical files; say so in the review handoff.
- The nest build externalizes dependencies (`dist/apps/*/main.js` imports from `node_modules`), so the runtime image needs production `node_modules`. Verify the built app starts in the image rather than assuming.
- `libs/prisma/src/generated` is gitignored; `prisma generate` must run in the build stage.
- Node's bundled npm 10.9.3 crashes on this project; `node:24` ships a newer npm. If `npm ci` fails in the image, use `npx -y npm@11 ci` as the existing CI does.
- `/ready` is the compose healthcheck; use `node -e` with `fetch` since the slim image has no curl.
- Do not add a logging driver, metrics, or an app-level production env schema. Required-variable checks live in compose; existing Zod schemas still validate at app startup.
- Bedrock: the AWS account's Bedrock access is currently suspended. Leave `AWS_REGION` unset in the local rehearsal so failover to Bedrock stays off.
- Seed uses the dev password; the `seed` job must not run automatically and the README must say so.
- Do not push, tag, or deploy. Create the feature branch from `master` at `/implement`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":10756,"specSha256":"8b22a43ab5d668a2cfc002ab492e44ebc5f69389e607dcd836cf171b1a1dabbc","branch":"refs/heads/feature/containers-and-production-compose","head":"a8f1bffe0e3a656427a8f36af78c2cfaafd49c66","baseRef":"refs/heads/master","baseCommit":"dd0b19fdb55301ec60436d8b8175bc6ff219fc04","sourceTree":"06d39d1fe00bcd1162e61c5d8e9e6b5ae0483390","absentOptional":[]} -->

## Independent review

**Status:** passed
**Target commit:** a8f1bffe0e3a656427a8f36af78c2cfaafd49c66
**Base commit:** dd0b19fdb55301ec60436d8b8175bc6ff219fc04
**Base ref:** refs/heads/master
**Spec hash:** 8b22a43ab5d668a2cfc002ab492e44ebc5f69389e607dcd836cf171b1a1dabbc
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-19T16:07:17Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-19T16:30:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

## Commands

- `git rev-parse HEAD` and `git merge-base master HEAD`: pass (HEAD equals target; merge base equals recorded base)
- `sha256sum blueprint/context/current-feature.md`: pass (matches Spec hash)
- `git status --short`: pass (only blueprint/context/review.md differed before review)
- `git diff dd0b19f..a8f1bff` (stat and full non-test diff) plus reads of the spec, controller, PrismaService, specs, README and .gitignore: pass
- `npm test`, `npm run lint`, `npm run typecheck:spec`, `npx tsc -p apps/<app>/tsconfig.app.json --noEmit`, `git check-ignore .env.production`: unavailable (the command classifier returned no verdict in this session, so they did not run)

## Evidence

- Freshness confirmed: HEAD, base, spec hash all match the request.
- Network exposure: in docker-compose.prod.yml only `caddy` has `ports`; postgres and internal services have none; internal services bind via `HOST` (default 127.0.0.1, compose sets 0.0.0.0).
- Secrets: `.dockerignore` excludes `.env` and `.env.*`; no secret is set in the Dockerfile; AWS access keys are never passed; required vars use `${VAR:?}`; `ingest` alone gets `OPENAI_API_KEY`, `seed` is under the `jobs` profile. `.gitignore` lacks `.env.production` (F-01).
- Shutdown: `sse-connections.ts` hook order versus `PrismaService.onModuleDestroy` and the late-registration case are in F-02 and F-04; the controller's second `res.end()` after the hook is harmless.
- Health: `libs/prisma/src/health.controller.ts` returns no error detail; public exposure via Caddy is F-03.
- Tests: new specs for HealthController (ok, failure, timeout), SseConnections (3 cases) and `HOST` defaults in both services; no skipped or focused tests found. Container behavior is covered only by the manual proof the spec declares.

## Findings

- F-01 [P2] open
- F-02 [P3] unverified
- F-03 [P3] open
- F-04 [P3] open

## Remaining risk

- Test, lint and typecheck commands could not be run by this reviewer (classifier unavailable); their passing state rests on the builder's report.
- Docker image builds, compose behavior and the SIGTERM exit 143 were not re-run (Docker use was out of bounds); no automated test covers them.
- F-02 is an unconfirmed ordering concern between Prisma disconnect and the SSE shutdown hook.
- No dependency vulnerability scan was run.
