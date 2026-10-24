# Feature: Daily cost budget

**From build-plan:** feature 12a
**Build attempt:** 1
**Branch:** feature/daily-cost-budget
**Status:** verified

## Goal

A spend guard for the public demo: the gateway adds up today's estimated model cost from the stored traces and, once a configured USD cap is reached, answers every chat message with a fixed reply instead of running the agent, until the budget resets at 00:00 UTC. Per the owner's decisions, the fixed reply is a normal `final` event with a new route value `budget` (status ok, no model call), so the console shows it like any answer and the dashboard counts it per route; and the cap is an optional env variable, off when unset, so development, tests, CI and evals behave as today.

## In scope

- **Configuration**: `DAILY_BUDGET_USD`, optional positive decimal (for example `2.00`); empty or unset disables the budget; zero, negative or non-numeric fails startup with a message naming the variable. Added to `env.ts` (+ spec), `.env.example`, `.env.production.example` (with a suggested value left for the owner to choose) and passed through, empty by default, to `orderops-agent` in `docker-compose.prod.yml`.
- **Today's spend**: `TraceStore.costSince(since: Date): Promise<number>`, the sum of `LlmCall.costUsd` for traces created at or after `since` (calls without a price count as 0), using the existing `ChatTrace.createdAt` index.
- **Budget check**: a small `DailyBudget` provider in the chat module, `null` when the variable is unset; `exceeded(now)` compares `costSince(<start of the UTC day of now>)` with the cap (`>=` means exceeded). If the spend query fails, the check counts as exceeded (fail closed: the guard protects money) and logs the error type only.
- **Short-circuit in `ChatService.reply`**: before the graph runs, when the budget is exceeded, yield `final` `{ answer: BUDGET_REPLY, orderIds: [], route: 'budget', threadId }`, then the usual `trace` event (route `budget`, no tools, no calls, cost null, status `ok`), and store the trace like any other request. No model call, no orders call, no checkpointer write (the message is not added to the thread). With no budget configured, nothing is queried and the flow is unchanged.
- **Route type**: `ReplyRoute = ChatRoute | 'budget'` for the `final` event, the `trace` event, the trace record and the observability list item; the router's intent list (`chatRouteSchema`) and the eval dataset schema are unchanged. `GET /observability/traces?route=budget` is accepted.
- **Console**: `budget` added to the dashboard's route filter and to the viewer traces route's allowed values; the chat already renders a `final` answer and its timeline (route `budget`).
- **Docs**: `AGENTS.md` (variable, behavior, fixed reply, route value, reset time, fail-closed, overshoot), README (one paragraph), `docs/deploy.md` (set it in `.env.production` before making the demo public).

## Out of scope

- Per-IP or per-customer rate limits, CORS (12b); demo data reset and credentials (12c).
- Counting costs outside chat traces: eval runs, the policy ingest, FAQ embedding calls, Langfuse.
- Stopping requests already running when the cap is crossed (they finish; the cap can be exceeded by their cost).
- A budget per customer, per provider or per model; alerts or notifications; any UI to change the cap.
- Changing the router, the graph, or any other reply.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. No new dependency and no migration. Gates are `manual`; `/audit independent current` before `/complete` is offered. The live check at the end runs against the local stack with Playwright, started with the owner's go-ahead (approving this spec), and stopped afterwards.

## Build steps

- [x] 1. Reply route type. `ReplyRoute` in `chat.schemas.ts`; `FinalReply.route`, `TraceSummary.route`, `TraceRecord.route`, the collector's route and `TraceListItem.route` use it; the observability list query accepts `budget`. Done when: the three app typechecks and `npm run typecheck:spec` pass, an observability schema or e2e spec shows `route=budget` is accepted and `route=other` still returns 400, and `npm test` passes.
- [x] 2. Configuration, spend query and budget check. `DAILY_BUDGET_USD` in `env.ts`, `costSince` on `PrismaTraceStore`, `DailyBudget` (provider + factory from env) with an injectable clock. Done when: `env.spec.ts` shows unset and empty disable it, `2.00` parses to 2, and `0`, `-1` and `abc` fail with the variable named; `trace.store.spec.ts` shows the aggregate filters by `trace.createdAt >= since` and maps a null sum to 0; a `daily-budget` spec with a fixed clock shows the window starts at 00:00 UTC of the current day (also just after midnight and just before), spend equal to the cap counts as exceeded, spend below does not, and a failing query counts as exceeded.
- [x] 3. Short-circuit. `ChatService.reply` checks the budget first and answers with `BUDGET_REPLY`. Done when: `chat.service.spec.ts` shows that with the budget exceeded the events are exactly `final` (route `budget`, fixed text, the request's `threadId`) then `trace` (route `budget`, no calls, status `ok`), the graph and the orders client are never called, the trace is stored, and the checkpointer is untouched; that under the cap the normal flow runs; and that without a budget no spend query happens. An e2e case (budget provider overridden as exceeded) shows the SSE stream and its content type; the e2e suite passes.
- [x] 4. Console and docs. `budget` in the console's route lists; the env examples, compose pass-through and docs above. Done when: the viewer traces route spec accepts `route=budget`; `docker compose -f docker-compose.prod.yml --env-file .env.production.example config -q` passes (required variables given dummy values); `AGENTS.md` describes the variable and behavior; `web` typecheck, test and build pass; `git diff` touches only files listed in this spec.

## Live check (after step 4)

With the local stack started for the check (`DAILY_BUDGET_USD` set in the root `.env` to a value below today's local spend, which the dashboard shows): send a chat in the console as a customer and confirm the fixed reply appears as a normal answer and the timeline shows route `budget`, no tools, no model, cost not priced; on the dashboard confirm the `budget` route appears in Metrics and the trace filter finds it. Then remove the variable, restart, and confirm a normal answer. Results go in the final report; anything not observed is reported as not observed. The owner's `.env` is restored to its previous content.

**Observed 2026-10-23** (local stack started for the check and stopped afterwards; `DAILY_BUDGET_USD=0.10` passed to the gateway process, the owner's `.env` never edited; today's local spend before the check was $0.192 by SQL over `LlmCall` since 00:00 UTC):

- Console as Cora: "Where is my most recent order?" got the fixed reply as a normal answer; the timeline showed route `budget`, tools none, provider/model none, 0 tokens, cost "not priced", latency 1 ms, status `ok`, trace `09c2711c-…`.
- Dashboard as Vic: Metrics listed a `budget` row (1 request, 1 ms); the route filter offered `budget` and found that trace (0 calls, not priced).
- After restarting without the variable, the same question as Cora ran the agent (route `order`, model `claude-haiku-4-5-20251001`, status `ok`).
- Not observed live: the fail-closed path (unit spec only) and the reset at 00:00 UTC (unit spec with a fixed clock only).

Deviations from the file list: `apps/orderops-agent/src/evals/run.ts` (its `CaseRun.route` takes the `final` route, so it is now `ReplyRoute`) and a new `apps/orderops-agent/test/budget.e2e-spec.ts` instead of a case in `chat.e2e-spec.ts` (the budget override applies to a whole app instance).

## Files / areas

- Changed (gateway): `apps/orderops-agent/src/chat/chat.schemas.ts`, `chat.service.ts` (+ spec), `chat.module.ts`, `apps/orderops-agent/src/env.ts` (+ spec), `apps/orderops-agent/src/trace/trace.store.ts` (+ spec), `trace-recorder.ts`, `apps/orderops-agent/src/observability/observability.schemas.ts` and `observability.store.ts`, `apps/orderops-agent/test/chat.e2e-spec.ts` (and `observability.e2e-spec.ts` if the route filter is tested there).
- New (gateway): `apps/orderops-agent/src/chat/daily-budget.ts` (+ spec).
- Changed (console): `web/src/app/api/viewer/traces/route.ts`, `web/src/components/traces-section.tsx`, `web/src/app/api/viewer.spec.ts`.
- Config and docs: `.env.example`, `.env.production.example`, `docker-compose.prod.yml`, `AGENTS.md`, `README.md`, `docs/deploy.md`.
- Untouched: the graph, router and nodes, the eval runner and dataset, Prisma schema and migrations, the observability summary SQL, CI and deploy workflows.

## Data / contracts

- **`DAILY_BUDGET_USD`**: optional; positive decimal USD; unset or empty = no budget.
- **Budget window**: from 00:00:00.000 UTC of the current day; the comparison is `today's spend >= cap`.
- **Today's spend**: the sum of `LlmCall.costUsd` (the estimate from `models/pricing.ts`) over traces with `createdAt >= window start`; unpriced calls add 0; costs outside chat traces are not counted.
- **Fixed reply**: `BUDGET_REPLY = "The OrderOps demo has reached its daily usage limit, so the assistant is paused until 00:00 UTC. Please try again after that."`; sent as `final` with `orderIds: []`, `route: 'budget'` and the request's `threadId`; never model output.
- **Route value**: `budget` appears in `final.route`, `trace.route`, stored `ChatTrace.route`, the observability list, detail, summary `byRoute`, and as an accepted list filter. The router never returns it.
- **Failure semantics**: a failing spend query is treated as exceeded (fixed reply, error type logged, no secret or query text in logs).

## Testing

Unit specs for the env rule, the spend aggregate, the budget window and threshold (fixed clock), and the service short-circuit; an e2e case for the SSE stream with the budget exceeded; the console's route filter spec. Run once at the end: `npm run lint`, the three app typechecks, `npm run typecheck:spec`, `npm test`, `npm run test:e2e`, the prod compose config check, and in `web/`: `npm run typecheck`, `npm test`, `npm run build`. The live behavior is proven only by the live check.

## Notes for the AI

- Keep `chatRouteSchema` (router intents, eval dataset) unchanged; `budget` is a reply route, never an intent.
- Check the budget before the graph starts; the short-circuit must not touch the checkpointer, the orders service or any model.
- Fail closed on a spend-query error, and say so in a code comment and in `AGENTS.md`.
- Do not edit the owner's `.env` without restoring it; prefer passing the variable to the started process.
- Install nothing new; no migration. Never commit, push or deploy from `/implement`; add no AI attribution.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":10962,"specSha256":"864f1711e7b60f03ce66051c8a5563538a6d2c65871e7263ae1c51ac809ed500","branch":"refs/heads/feature/daily-cost-budget","head":"8f8297344620a2faf9f13e6e1eda671c0880c1c4","baseRef":"refs/heads/master","baseCommit":"8f8297344620a2faf9f13e6e1eda671c0880c1c4","sourceTree":"46ad9904305777609a5b733ef06ba76b3df26d47","absentOptional":[]} -->
