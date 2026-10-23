# Feature: Observability dashboard

**From build-plan:** feature 11c
**Build attempt:** 1
**Branch:** feature/observability-dashboard
**Status:** verified

## Goal

A dashboard page in the demo console (`/dashboard`) where a reviewer logs in with one click as the seeded read-only viewer and sees how the agent behaves in aggregate and per request: p50/p95 latency overall and by route, cost per conversation, tokens and cost by model, the cached-token share, error and failover rates, a trace explorer whose detail view lists the model calls and links to the matching Langfuse trace, and the eval scorecard by provider. Everything comes from the existing read-only observability API (10b). Per the owner's decision, 11c also fixes finding F-22 so the trace detail lists model calls in the order they ran.

## In scope

- **Gateway: call order (F-22)**. A `seq` integer on `LlmCall` (hand-written migration `ALTER TABLE "LlmCall" ADD COLUMN "seq" INTEGER NOT NULL DEFAULT 0`; existing rows keep 0), set from each call's position in `TraceRecord.calls` when the trace is stored, and `GET /observability/traces/:id` ordered by `seq`, then `createdAt`, then `id`. The response shape does not change. Traces stored before the migration keep their arbitrary order. F-22 is marked `fixed` in the findings ledger (only a later `/audit` closes it).
- **Console: viewer session**, a third session kind beside customer and operator: `POST /api/viewer/login` (only `viewer@example.com`, server-only `DEMO_PASSWORD`; cookies `orderops_viewer_token` and `orderops_viewer_email`, same flags as 11a), `POST /api/viewer/logout`, `GET /api/viewer/session`. The customer and operator logins keep rejecting the viewer email.
- **Console: viewer proxy routes** (closed, viewer token only):
  - `GET /api/viewer/summary?window=24h|7d|30d` → gateway `GET /observability/summary?since=<now minus window>`; default `7d`; any other window is 400.
  - `GET /api/viewer/traces?route=&status=&before=` → gateway `GET /observability/traces` with `limit=50` and only those three parameters, each validated first (`route` one of `faq|order|refund|out_of_scope`, `status` one of `ok|error|aborted`, `before` a uuid); anything else is 400 without a gateway call.
  - `GET /api/viewer/traces/[id]` (`id` a uuid) → gateway `GET /observability/traces/:id`; 404 passes through.
  - `GET /api/viewer/evals` → gateway `GET /observability/evals/latest`.
  - Gateway 401 clears the viewer cookies; 403 (token without the viewer role) is passed through with a fixed message; unreachable is 502.
- **Dashboard page** (`/dashboard`):
  - Logged out: "Log in as Vic Viewer (viewer@example.com)" and links to the customer chat and the operator console.
  - Logged in, three sections with a heading each: **Metrics**, **Traces**, **Evals**; header with a window selector (Last 24 hours / 7 days / 30 days, default 7 days, applies to Metrics), "Log out" and links to the other pages.
  - **Metrics**: requests, error rate, failover rate, cached-token share and p50/p95 latency overall as stat tiles; latency by route as a table with a CSS bar for p95 (route `null` shown as "no route"); cost per conversation (conversations, average, max, total, unpriced count); tokens and cost by model as a table (provider, model, calls, input, output, cache read, cost). Empty window (`requests: 0`): one "No requests in this window." message instead of empty tables.
  - **Traces**: newest first, 50 per page with "Load more" (via `nextBefore`), filters for route and status; each row shows time, route, status, latency, calls, cost and failovers. Selecting a row opens its detail: the list fields plus every model call (tier, provider, model, tokens, latency, cost) in call order, and "Open in Langfuse" linking to `<LANGFUSE_PROJECT_URL>/traces/<id without dashes>` when that variable is set (hidden otherwise). Customer and thread ids are shown as plain text; no message text exists in this API.
  - **Evals**: one card per provider with run time, git sha (short), models (cheap/strong), cases (and "truncated: N of M run" when cut short), overall pass rate, the per-metric rates the summary contains, per-category pass rates, agent cost and judge cost when judged. When `comparable` is false, a note says the runs used different datasets. Empty: "No eval results are committed yet. Run `npm run eval` and commit `evals/results/`."
  - States per section: loading, error with retry, session expired (back to the viewer login with a notice).
- **Config**: optional server-only `LANGFUSE_PROJECT_URL` in the console (`web/.env.example`), for example `https://us.cloud.langfuse.com/project/<project-id>`; read by the dashboard page on the server and passed to the client; ignored unless it starts with `https://` or `http://`.
- **Docs**: `AGENTS.md` (call order, dashboard, viewer session and routes, `LANGFUSE_PROJECT_URL`), README (one paragraph), `docs/deploy.md` "Demo console (Vercel)" (the optional variable).

## Out of scope

- New gateway metrics or endpoints; changing summary, list or eval response shapes (only the detail call order changes).
- Backfilling call order for traces stored before the migration.
- Charting libraries, time-series charts, auto-refresh.
- Running evals or committing eval results (the scorecard shows whatever is committed; none is today).
- Operator use of the dashboard (operators may call the API, but the console logs in only as the viewer), public deployment, rate limits and CORS (item 12).
- Markdown rendering, `models[]`, and the other 11a/11b follow-ups.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. No new dependency is needed. Step 1 adds a migration: it is applied locally with `npx prisma migrate deploy` (never `migrate dev`, which reports drift from library-managed tables and asks to reset), followed by `npx prisma generate`. Gates are `manual`; `/audit independent current` before `/complete` is offered (persisted-data change plus a third console session). The browser check runs with Playwright against the local stack, started with the owner's go-ahead as in 11b.

## Build steps

- [x] 1. Call order (F-22). `seq` in `prisma/schema.prisma`, migration `prisma/migrations/20261023120000_llm_call_seq/migration.sql`, `seq` set by index in `PrismaTraceStore.record`, detail ordered by `seq` in `observability.store.ts`, the comment there updated. Done when: `trace.store.spec.ts` shows the nested create gives each call its array index as `seq`; `observability.store.spec.ts` shows the detail query orders by `seq`, `createdAt`, `id`; `npx prisma migrate deploy` applies the migration locally and `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` reports no drift; the three app typechecks, `npm test` and `npm run test:e2e` pass; F-22 is marked `fixed` with the resolution noted.
- [x] 2. Console viewer session and proxy routes. A `viewer` kind in `web/src/lib/server.ts`, `forwardJson` given an optional validated query string, `DEMO_VIEWER` in `demo-customers.ts`, and the routes above. Done when: Vitest specs (mocked `fetch`) show the viewer login calls the gateway only with `viewer@example.com` and sets only the viewer cookies; customer and operator logins reject the viewer email; every viewer route returns 401 with only a customer or operator cookie; `window` maps to the right `since` (fixed clock in the spec) and a bad window is 400; the trace list forwards only validated `route`, `status`, `before` plus `limit=50` and rejects anything invalid with 400 without a gateway call; the detail route rejects a non-uuid id; 401 clears only the viewer cookies, 403 passes through with a fixed message, unreachable is 502.
- [x] 3. Dashboard shell and Metrics. `web/src/app/dashboard/page.tsx` (server component reading `LANGFUSE_PROJECT_URL`), viewer login and session handling, window selector and the Metrics section, with formatting helpers in `web/src/lib/observability.ts`. Done when: specs for the helpers show percentages, milliseconds, USD and token counts formatted, the empty-window rule, and the Langfuse URL built only from an http(s) base with the dashes removed (null otherwise); `web` typecheck, test and build pass.
- [x] 4. Trace explorer. Filters, list, "Load more", detail with calls in returned order and the Langfuse link. Done when: a reducer or helper spec shows pages append in order, changing a filter resets the list and cursor, and the last page hides "Load more"; `web` typecheck, test and build pass.
- [x] 5. Eval scorecard. Cards per provider, comparable note, truncated note, empty state. Done when: a helper spec shows a truncated run's "N of M" text, a null rate shown as "n/a", and judge cost shown only for judged runs; `web` typecheck, test and build pass; steps 3-5 are covered by the browser check below.
- [x] 6. Docs. Done when: `AGENTS.md` describes the call order (new traces in call order, older ones arbitrary), the dashboard, viewer session and routes, and `LANGFUSE_PROJECT_URL`; README and `docs/deploy.md` mention the dashboard and the variable; `git diff` touches only files listed in this spec.

## Browser check (after step 5)

Driven with Playwright against the local stack (started with the owner's go-ahead, stopped afterwards), after one or two chats so new traces exist: open `/dashboard`, log in as Vic, confirm the Metrics tiles and tables render for 7 days and that switching to 24 hours refetches; in Traces, filter by route, open a new trace and confirm its calls are listed in call order (router call first) and, with `LANGFUSE_PROJECT_URL` set in `web/.env.local`, that the Langfuse link has the dashless id; confirm the Evals empty state (no results are committed); log out and confirm the customer chat session is unaffected. Results go in the final report; anything not observed is reported as not observed.

**Observed 2026-10-23** (Playwright in Chromium; local stack started for the run and stopped afterwards; `LANGFUSE_PROJECT_URL` passed to the console process, `web/.env.local` unchanged):

- A new chat as Ana stored trace `bd9ce284-…` with `LlmCall.seq` 0-4: router (cheap), three strong calls, memory step (cheap).
- `/dashboard` login as Vic; Metrics for 7 days showed 35 requests, error rate 2.9%, failover rate 0%, p50/p95, latency by route with bars (order, refund, out_of_scope, no route), cost per conversation and tokens by model (Anthropic and earlier Bedrock rows). Switching to 24 hours refetched (10 requests; order and refund).
- Traces: one table of 50 unique rows newest first; "Load more" appended the last 6 (56 unique) and then disappeared; the route filter reset the list (16 rows, all refund).
- The detail of `bd9ce284-…` listed its 5 calls in stored order and "Open in Langfuse" pointed to `…/project/cmvl2zfyn00npad0jd75c45lv/traces/bd9ce284985f4b30a9cda5a69cfb3d52` with `target="_blank"` and `rel="noopener noreferrer"`.
- Evals showed the empty state (no committed results).
- Logging out of the dashboard left the customer session in the same browser logged in (a reload still showed Ben from the 11b run).
- Browser console after the fixes below: no errors besides the expected logged-out `/api/viewer/session` 401s.

Fixed during the check (in scope of this feature's pages): the trace explorer appended its first page twice when React re-ran the mount effect (duplicate rows and key errors), now each run resets the list and invalidates the in-flight load; dashboard table cells broke short words, now they break only values too long for the cell; and `web/next.config.ts` sets `turbopack.root` to `web/`, because Next picked the repo root (two lockfiles) and watched the whole repo, so files written there reloaded the console in a loop (this also removes the build warning noted in 11b). Not exercised live: the 403 and session-expiry paths (route specs only), narrow layout, the eval cards with data. The scorecard says "N cases (truncated by the cost cap)" instead of "N of M" because result files do not record the dataset size.

## Files / areas

- Changed (gateway): `prisma/schema.prisma`, `apps/orderops-agent/src/trace/trace.store.ts` (+ spec), `apps/orderops-agent/src/observability/observability.store.ts` (+ spec), `blueprint/context/findings.md` (F-22 status).
- New (gateway): `prisma/migrations/20261023120000_llm_call_seq/migration.sql`.
- Changed (console): `web/src/lib/server.ts`, `web/src/lib/demo-customers.ts`, `web/src/app/api/operator.spec.ts` or a new spec file, `web/src/app/globals.css`, `web/src/components/login-view.tsx` and `operator-console.tsx` (links to the dashboard), `web/.env.example`.
- New (console): `web/src/app/api/viewer/{login,logout,session,summary,evals}/route.ts`, `web/src/app/api/viewer/traces/route.ts`, `web/src/app/api/viewer/traces/[id]/route.ts`, `web/src/app/dashboard/page.tsx`, `web/src/lib/observability.ts` (+ spec), dashboard components under `web/src/components/`.
- Docs: `AGENTS.md`, `README.md`, `docs/deploy.md`.
- Untouched: the observability controller and response shapes, the report CLI, the eval runner, the chat and operator flows, CI and deploy workflows.

## Data / contracts

- **`LlmCall.seq`**: `INTEGER NOT NULL DEFAULT 0`; the call's zero-based position in the request's recorded calls (the collector's in-memory order, which is the real call order); 0 for rows stored before the migration. Not exposed in any response.
- **Trace detail order**: `seq ASC, createdAt ASC, id ASC`.
- **Viewer cookies**: `orderops_viewer_token`, `orderops_viewer_email`; httpOnly, SameSite=Lax, path `/`, Secure in production, max-age = gateway `expiresIn`. Used only by `/api/viewer/*`.
- **Console routes**: `POST /api/viewer/login` → 200 `{ email }` | 401 | 502 | 500; `POST /api/viewer/logout` → 204; `GET /api/viewer/session` → 200 `{ email }` | 401; `GET /api/viewer/summary` → gateway `SummaryResponse` | 400 | 401 | 403 | 502; `GET /api/viewer/traces` → `TraceListResponse` | 400 | 401 | 403 | 502; `GET /api/viewer/traces/[id]` → `TraceDetail` | 400 | 401 | 403 | 404 | 502; `GET /api/viewer/evals` → `LatestEvalsResponse` | 401 | 403 | 502.
- **Windows**: `24h`, `7d`, `30d` → `since` = request time minus 24, 168 or 720 hours, ISO 8601 UTC.
- **Langfuse link**: `<LANGFUSE_PROJECT_URL without trailing slash>/traces/<ChatTrace.id with dashes removed, lowercase>`, opened in a new tab with `rel="noopener noreferrer"`.
- **Rendering**: all values as plain React text; customer ids, thread ids and route names are data, not markup.

## Testing

Gateway: `trace.store.spec.ts` (seq), `observability.store.spec.ts` (order), local `migrate deploy` plus the drift check, and the existing e2e suite. Console: Vitest specs for the viewer routes (mocked `fetch`) and for the formatting, Langfuse URL, paging and scorecard helpers. Run once at the end: `npm run lint`, the three app typechecks, `npm run typecheck:spec`, `npm test`, `npm run test:e2e`, and in `web/`: `npm run typecheck`, `npm test`, `npm run build`. The rendered dashboard is proven only by the Playwright browser check.

## Notes for the AI

- Write the migration by hand and apply it with `npx prisma migrate deploy`; never run `prisma migrate dev` or reset the database.
- Keep the observability API response shapes unchanged; the console adapts to them.
- Viewer, operator and customer tokens must never cross routes; extend the existing session tests.
- Keep the proxy closed: fixed upstream paths, whitelisted query parameters validated before forwarding, no pass-through of arbitrary query strings.
- Do not start servers without the owner's go-ahead; stop them and delete `.playwright-mcp/` after the browser check.
- Install nothing new. Never commit, push or deploy from `/implement`; add no AI attribution.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":15885,"specSha256":"630021c9b2d6add65623f33a031615cd349e5e3d731ca18ed57b1d54ba3aa075","branch":"refs/heads/feature/observability-dashboard","head":"944a0e1a6b520c008112686cfad2bfec0d60250b","baseRef":"refs/heads/master","baseCommit":"944a0e1a6b520c008112686cfad2bfec0d60250b","sourceTree":"595279100d4d30d192b87c87e306d51fa2af64a5","absentOptional":[]} -->
