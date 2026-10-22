# Feature: Viewer role and read-only observability API

**From build-plan:** feature 10b
**Build attempt:** 1
**Branch:** feature/viewer-role-and-read-only-observability-api
**Status:** verified

## Goal

A read-only `viewer` role and four read-only endpoints on the gateway that expose what the agent did, built on the existing trace report logic: summary metrics, a filterable trace list, one trace in detail, and the latest eval results per provider. Operators may read them too; customers may not. Eval results come from the committed `evals/results/*.json` files, baked into the image (owner's decision), so they change only when new results are committed and deployed.

## In scope

- **Viewer role**
  - `viewer` added to the `UserRole` enum (Prisma schema + hand-written migration `ALTER TYPE "UserRole" ADD VALUE 'viewer';`).
  - `libs/auth`: `UserRole` type gains `viewer`; `JwtAuthGuard` maps the exact string `viewer` to the viewer role (anything unknown is still a customer); a new `ViewerGuard` admits `viewer` and `operator` and throws 403 for anyone else. `OperatorGuard` is unchanged, so a viewer gets 403 on the refund endpoints.
  - Login: `LoginService`'s verified-credentials schema accepts `viewer`; customers-service already returns the stored role.
  - Seed: one viewer, `view_vic` / `viewer@example.com`, same dev password and tier `standard`, no orders.
- **Shared metrics** (`apps/orderops-agent/src/trace/trace-metrics.ts`): the SQL now inline in `report-traces.ts` moves into functions that take a small query runner `(sql, params) => Promise<rows>`, so the CLI keeps using `pg` and the API uses Prisma's raw query. Added: request count, error rate (`status = 'error'` / all traces) and failover rate (traces with `failovers > 0` / all traces) in the window. `npm run report:traces` prints exactly what it prints today.
- **Endpoints** (new `ObservabilityModule`, guarded by `JwtAuthGuard` + `ViewerGuard`, all `GET`):
  - `/observability/summary?since=` - the report data as JSON plus the rates above.
  - `/observability/traces?since=&until=&route=&status=&limit=&before=` - newest first, keyset pagination.
  - `/observability/traces/:id` - one trace with its model calls.
  - `/observability/evals/latest` - latest result per provider from the baked files, with summaries only.
- **Eval results in the image**: remove `evals/results` from `.dockerignore`, and the runtime stage copies `evals/results` from the build stage. The endpoint reads `<cwd>/evals/results` (the container's working directory is `/app`; locally the repo root), reusing `readResults` and `latestPerProvider` from `evals/compare.ts`.
- **Docs**: an `AGENTS.md` bullet for the endpoints, the viewer role and the seeded viewer; a README line in the walkthrough's operator/observability part.

## Out of scope

- Langfuse (10c), the console UI (11), rate limits, budgets and CORS (12), any write endpoint.
- Changing who may chat: `/chat` stays open to any authenticated token, viewer included (a viewer has no orders); restricting it is a later decision.
- Message text, prompts, tool arguments or per-case eval answers in any response; aggregating or caching beyond what the SQL does; a production viewer account (the seed is dev-only and never runs automatically, as today).
- Importing eval results into the database, or reading them from anywhere but the baked files.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement all steps in order, one review packet at the end, no per-step pauses or checkpoint commits. The independent review gate is `manual` in this project's config, so none is selected automatically even though this feature adds an authorization role; the final packet will say so, and `/audit independent current` remains available on request before `/complete`.

## Build steps

- [x] 1. Viewer role and guard. Enum value and migration (`prisma/migrations/20261022130000_viewer_role/migration.sql`), `libs/auth` type, `JwtAuthGuard` mapping and `ViewerGuard` (exported from `@app/auth`), login schema, seeded viewer. Done when: guard specs show `viewer` and `operator` tokens pass `ViewerGuard`, a `customer` and a token with an unknown role get 403, and `JwtAuthGuard` maps `viewer` exactly (`Viewer` or `viewer ` stay customers); `login.service.spec.ts` accepts a `viewer` role from customers-service; on a fresh throwaway pgvector container `npx prisma migrate deploy` applies it and the CI drift check exits 0; `npx prisma db seed` against the local database creates `view_vic` and is still idempotent on a second run.
- [x] 2. Shared metrics. Move the report queries into `trace-metrics.ts` (latency overall and by route, cost per conversation, by model) and add the counts behind the error and failover rates; `report-traces.ts` keeps its CLI behavior and output format by calling these functions with a `pg` runner. Done when: `trace-metrics.spec.ts` runs each function against a fake runner and checks the SQL receives `since` (and `until` where used) as a bind parameter, never interpolated, and maps rows into the existing `LatencyRow`, `ConversationRow`, `ModelRow` shapes; the rates are 0 with no traces (no division by zero); `npm run report:traces` against the local database prints the same sections as before (shown in the report).
- [x] 3. Observability API: summary, trace list and trace detail. `ObservabilityModule` with a store interface (`OBSERVABILITY_STORE`, Prisma implementation using the shared metrics, `$queryRaw` with bound parameters, and `chatTrace.findMany` / `findUnique` for list and detail) so e2e can swap it like `TRACE_STORE` and `REFUND_STORE`; query validation with Zod through the existing `ZodValidationPipe`. Done when: e2e specs show 401 without a token, 403 for a customer, 200 for a viewer and for an operator on all three routes; 400 for an invalid `since`/`until`, an unknown `route` or `status`, `limit` outside 1-200, and a trace id that is not a UUID; 404 for an unknown trace id; the list is newest first, honors each filter, returns `nextBefore` only when more rows exist, and paging with `before` returns the next page without overlap; no response contains a message text field.
- [x] 4. Latest eval results. `GET /observability/evals/latest` reads the directory through an injectable path (default `join(process.cwd(), 'evals/results')`), reuses `readResults` and `latestPerProvider`, and returns summaries without `cases`; `.dockerignore` and `Dockerfile` changes so the files ship in the image. Done when: a unit spec with a temp directory shows two runs of one provider return only the newer one, providers sorted by name, `cases` removed and `caseCount` present, an empty or missing directory gives `{ providers: [] }`, and a malformed JSON file gives a 500 without its content in the response; the e2e spec shows the route's 401/403/200; `docker build --target runtime --build-arg APP=orderops-agent .` succeeds locally and `evals/results` exists in that image (`docker run --rm --entrypoint ls <image> evals/results`).
- [x] 5. Docs. `AGENTS.md` bullet (routes, query parameters, roles, viewer seed login, eval files baked into the image) and one README line. Done when: both name the four routes and that a customer token gets 403, and `git diff` outside the files listed in this spec shows nothing else.

## Files / areas

- Changed: `prisma/schema.prisma`, `prisma/seed.ts`, `libs/auth/src/jwt-auth.guard.ts` (+ spec), `libs/auth/src/index.ts`, `apps/orderops-agent/src/auth/login.service.ts` (+ spec), `apps/orderops-agent/src/trace/report-traces.ts`, `apps/orderops-agent/src/app.module.ts`, `Dockerfile`, `.dockerignore`, `AGENTS.md`, `README.md`.
- New: `prisma/migrations/20261022130000_viewer_role/migration.sql`, `libs/auth/src/viewer.guard.ts` (+ spec), `apps/orderops-agent/src/trace/trace-metrics.ts` (+ spec), `apps/orderops-agent/src/observability/` (module, controller, store, schemas, eval reader, specs), `apps/orderops-agent/test/observability.e2e-spec.ts`.
- Check during step 1: whether customers-service or orders-service declare their own role type or schema that rejects `viewer` (they import `UserRole` from the shared auth lib or the Prisma client); adjust only what rejects it.

## Data / contracts

- **Roles**: `UserRole = 'customer' | 'operator' | 'viewer'`. The role comes only from the verified JWT (`role` claim), never from the request. The JWT for a viewer is issued by the existing `/auth/login` from the stored `Customer.role`. Adding an enum value is not reversible with a simple down migration in Postgres; a rollback would leave the value unused.
- **Auth results**: missing or invalid token 401; customer (or unknown role) 403; viewer or operator 200. Nest's default error body `{ statusCode, message, error }`, as elsewhere.
- **`GET /observability/summary?since=<ISO 8601 date-time or date>`** (default: 7 days before now): `{ since, until, requests, errorRate, failoverRate, overall: { requests, p50, p95 } | null, byRoute: [{ route | null, requests, p50, p95 }], conversations: { count, totalUsd, averageUsd, maxUsd, unpriced }, models: [{ provider, model, calls, inputTokens, outputTokens, cacheReadTokens, costUsd }], cachedShare }`. Rates and `cachedShare` are numbers in [0, 1], 0 when there is no data. Money values are numbers rounded to 6 decimals; latencies in ms.
- **`GET /observability/traces`**: `since`/`until` (ISO, optional, `until` exclusive), `route` (`faq|order|refund|out_of_scope`), `status` (`ok|error|aborted`), `limit` (1-200, default 50), `before` (a trace id; returns traces strictly older in `(createdAt, id)` order). Response `{ traces: [{ id, createdAt, customerId, threadId, route, tools, status, latencyMs, failovers, calls, costUsd: string | null }], nextBefore: string | null }`, where `calls` is the number of model calls and `costUsd` the six-decimal sum of priced calls. An unknown `before` id gives 400.
- **`GET /observability/traces/:id`** (UUID): the list item fields plus `calls: [{ tier, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, latencyMs, costUsd: string | null, createdAt }]` in call order; 404 when absent.
- **`GET /observability/evals/latest`**: `{ providers: [{ provider, models, runAt, gitSha, datasetSha256, judge: {...} | null, summary, caseCount }], comparable: boolean }`, where `comparable` is true when every listed run used the same `datasetSha256` (the rule `eval:compare` applies). Per-case data (including model answers) is never returned.
- **Data exposure**: viewers see every customer's trace metadata (customer id, thread id, route, tools, tokens, cost, latency), as operators already see every pending refund. No prompts, messages, tool arguments, tool results or answers exist in these tables or responses.

## Testing

Unit specs for the guards, login schema, shared metrics (fake runner), eval reader (temp directory) and store mapping; e2e specs for every route with the store swapped for an in-memory fake, covering 401/403/200/400/404, filters and pagination. Run once at the end: `npm run lint`, the three app typechecks, `npm run typecheck:spec`, `npm test`, `npm run test:e2e`. The migration is checked on a fresh throwaway pgvector container with `migrate deploy` and the CI drift check; the seed and `report:traces` against the local database; the image contents with a local `docker build`. The Prisma store's real SQL against Postgres is exercised only through `report:traces` and a local smoke call of the summary route if the user starts the gateway (not started by the agent); the e2e suite uses a fake store, and the report must say so.

## Notes for the AI

- Follow the existing patterns: guards in `libs/auth` with specs like `operator.guard.spec.ts`, store tokens like `TRACE_STORE`, `ZodValidationPipe` for params and queries, `PrismaService` from `@app/prisma`.
- Bind every value in raw SQL (`$queryRaw` tagged template or positional parameters); never build SQL from query strings. `route` and `status` are validated enums before they reach the store.
- Do not use `npx prisma migrate dev`; write migrations by hand (see `AGENTS.md`).
- Do not return or log message text, answers or eval `cases`.
- Keep `report:traces` output byte-for-byte the same format.
- Add no AI attribution to commits; never commit, push or deploy from `/implement`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":12344,"specSha256":"7ee771e773b9f3aa9a83c2294e8f3d13815c3948b5e8fbf813514301d0c22fcf","branch":"refs/heads/feature/viewer-role-and-read-only-observability-api","head":"c1dbb31bfc06c219e40ce900ec47f6277087a2da","baseRef":"refs/heads/master","baseCommit":"58545c84da9ba905f20b8c85f95257de4ae7c513","sourceTree":"9ed3a59b5f8619936c9daf2502f2d2a55ecf1dad","absentOptional":[]} -->

## Independent review

**Status:** passed
**Target commit:** c1dbb31bfc06c219e40ce900ec47f6277087a2da
**Base commit:** 58545c84da9ba905f20b8c85f95257de4ae7c513
**Base ref:** refs/heads/master
**Spec hash:** 7ee771e773b9f3aa9a83c2294e8f3d13815c3948b5e8fbf813514301d0c22fcf
**Prepared by:** claude
**Builder model:** claude-opus-5-5
**Requested reviewer:** claude
**Requested model:** claude-opus-5-5
**Requested execution:** automatic
**Requested at:** 2026-10-22T17:20:00Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-opus-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-22T17:06:44Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

### Commands

- `npm run lint`: pass
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/orders-service/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/customers-service/tsconfig.app.json --noEmit`: pass
- `npm run typecheck:spec`: pass
- `npm test`: pass (45 files, 394 tests)
- `npm run test:e2e`: pass (6 files, 72 tests)
- `npx prisma migrate deploy` + CI drift check on a fresh pgvector container: unavailable (no servers or containers started by the reviewer)
- `docker build --target runtime --build-arg APP=orderops-agent .`: unavailable (not run by the reviewer)
- `npm run report:traces` against a live database: unavailable (no database started by the reviewer)

### Evidence

- Freshness verified: HEAD = target, `git merge-base refs/heads/master HEAD` = base, raw SHA-256 of `current-feature.md` = spec hash (tracked), only `blueprint/context/review.md` differed from the target.
- Reviewed the full 30-file `58545c8..c1dbb31` delta plus `trace.store.ts`, `chat.service.ts` thread key, `ChatTrace`/`LlmCall` schema, Dockerfile stages, and callers of `readResults`/`latestPerProvider`.
- Auth: `JwtAuthGuard` maps only exact `operator`/`viewer`; `ViewerGuard` admits viewer and operator, 403 otherwise; `OperatorGuard` unchanged; no other role checks in apps treat non-customer roles as privileged. Controller applies `JwtAuthGuard` + `ViewerGuard` at class level.
- SQL: every value in `trace-metrics.ts` is bound positionally (`$1`/`$2`); only fixed column prefixes and booleans shape the SQL; `$queryRawUnsafe` receives params separately. List/detail use Prisma `findMany`/`findUnique` with Zod-validated enums, UUIDs and a 1-200 limit.
- Data exposure: responses are built field by field (no message text); eval `cases` stripped; malformed eval JSON yields Nest's generic 500 (e2e asserts no content leak); exposed `threadId` cannot open another customer's checkpoint because the key is `${customerId}:${threadId}`.
- Performance: list is bounded (limit+1, relation loaded in one extra query), keyset pagination on indexed `createdAt`; summary runs five aggregate queries over an indexed window.
- No `.only`/`.skip`/`.todo` in specs.

### Findings

- F-22 [P2] open - trace detail `calls` order is arbitrary (UUID tiebreak), not the spec's "call order"; non-blocking.
- No P0 or P1 findings. Existing F-08 and F-19 are outside this delta and were not re-examined.

### Remaining risk

- The Prisma store's raw summary SQL (`$queryRawUnsafe` with Date params through the driver adapter) and the list/detail queries are exercised only with fakes in unit/e2e tests; not run against Postgres in this review.
- Migration apply and CI drift check on a fresh database were not run by the reviewer (unavailable).
- `docker build` and the `evals/results` presence in the runtime image were not verified by the reviewer (unavailable); only `evals/results/.gitkeep` is committed, so production serves `{ providers: [] }` until results are committed and deployed.
- `npm run report:traces` byte-for-byte output was not compared against a live database (unavailable); verified only by reading that the SQL moved unchanged into `trace-metrics.ts`.
- Seed idempotency for `view_vic` not executed (unavailable).
- Dashboard activity state (`blueprint/.state/run.json`) was not written by the reviewer, per the caller's write limit to the two review files.
