# Fix: Bound database connect time and test the paused-thread second turn

**Type:** Fix
**Status:** verified
**Branch:** fix/bound-database-connect-time-and-test-paused-thread-second-turn
**Fixes:** F-12, F-14

## The problem

Two unverified P3 findings from the feature 6 and 7a audits:

- **F-12.** `PrismaService` builds `PrismaPg` with only a connection string
  ([prisma.service.ts](libs/prisma/src/prisma.service.ts#L10)). `pg` pools have no
  connection timeout by default, so if the database accepts no connections and does
  not refuse them, every chat request leaves one fire-and-forget trace write pending
  (`ChatService.recordTrace`), holding its trace record for as long as the stall
  lasts.
- **F-14.** Eval case `adv-13` sends a second refund message on a thread the first
  turn paused at `await_approval`. The runner spec only uses scripted non-refund
  routes, so the real graph's behavior for new input on a paused thread (a fresh run
  that reuses the open request) has never run in a test. If LangGraph resumed or
  errored instead, the case would record an error instead of the duplicate outcome.

## The fix

- **F-12.** Pass `connectionTimeoutMillis: 10_000` to `PrismaPg` in `PrismaService`.
  A stalled connect then fails after 10 seconds, `recordTrace` already catches and
  logs the error, and the pending write is released. Nothing else changes; a refused
  connection already failed fast. The value is above the 5 second upstream timeout
  used elsewhere so a short pool wait under load is not turned into an error.
- **F-14.** Add a runner spec with scripted models and the real graph: the router
  says `refund`, the proposal names `ORD-1001` with a reason, and the case has two
  turns for `ana`. Assert the first turn pauses with `approval_required` and the
  second turn ends with one `final`, `refund.status` `pending_approval`, the same
  refund id (the open request is reused, no second row), no `approval_required`, and
  no recorded error. If the real graph behaves differently, record that as a finding
  instead of changing the dataset or agent in this fix.

## Build steps

- [x] 1. Add `connectionTimeoutMillis: 10_000` to the `PrismaPg` options in
  `libs/prisma/src/prisma.service.ts`.
  **Done when:** `npm test`, `npx tsc -p apps/orderops-agent/tsconfig.app.json
  --noEmit` and `npm run lint` pass. There is no database-backed test harness for
  `PrismaService`; state that the stalled-connect behavior was not exercised live.
- [x] 2. Add the refund pause and second turn spec to
  `apps/orderops-agent/src/evals/run.spec.ts`.
  **Done when:** the new spec passes, `npm run typecheck:spec` and `npm run lint`
  pass, and `npm test` passes.

## Verify

- The F-14 spec is the proof for the paused-thread path; a live `npm run eval --
  --provider <p> --ids adv-13` is optional extra evidence and is reported only if
  actually run with real keys.
- `/audit` re-reviews F-12 and F-14 (marked `fixed` by `/implement`) before they
  close.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2989,"specSha256":"068d95aa9925a0ffb3effca9206b1fe19c0ff1b98e1f31387853c79f33124270","branch":"refs/heads/fix/bound-database-connect-time-and-test-paused-thread-second-turn","head":"266cc4445e1109d9cdeef2b5d73936b79d6073b2","baseRef":"refs/heads/master","baseCommit":"266cc4445e1109d9cdeef2b5d73936b79d6073b2","sourceTree":"29cf0c2de1ae78dd160920bdba77b3938df275c1","absentOptional":[]} -->

## Findings

### bound-database-connect-time-and-test-paused-thread-second-turn/F-12 [P3] closed - Unbounded pending trace writes if the database hangs

**File:** apps/orderops-agent/src/chat/chat.service.ts:167
**Found:** 2026-10-03 by /audit (scope: current; lens: performance)
**Why it matters:** Trace writes are now fire-and-forget. `PrismaService` builds `PrismaPg` with only a connection string (libs/prisma/src/prisma.service.ts:10) and `pg` pools have no connection timeout by default, so if the database accepts no connections and does not refuse them (a network black hole), each chat request leaves one pending write holding its trace record, and they accumulate for as long as the stall lasts. A refused connection fails fast and is unaffected. Not reproduced.
**Suggested fix:** Only if it matters in practice: give the adapter a `connectionTimeoutMillis` in `PrismaService`. Nothing else changes.
**Resolution:** 2026-10-03 fix/bound-database-connect-time-and-test-paused-thread-second-turn: `PrismaService` now passes `connectionTimeoutMillis: 10_000` to `PrismaPg`, so a database that accepts no connections fails the write after 10 seconds and `recordTrace` logs and releases it. The stalled-connect behavior was not exercised live (no database-backed harness). Awaiting `/audit` re-review. Closed 2026-10-03 by /audit current: `connectionTimeoutMillis: 10_000` is now the only option added beside the connection string in `prisma.service.ts`, and `recordTrace` still catches every error, so a stalled connect releases its pending write after 10 seconds. The repair introduced no new defect. The 10 second bound covers connecting and waiting for a pool client; a query on an already-open connection is still unbounded, which this finding did not cover. Not exercised live.

### bound-database-connect-time-and-test-paused-thread-second-turn/F-14 [P3] closed - Second turn on a thread paused for approval is untested

**File:** evals/dataset.json (case adv-13)
**Found:** 2026-10-03 by /audit (scope: current; lens: tests)
**Why it matters:** `adv-13` sends a second refund message on a thread the first turn paused at `await_approval`, relying on `graph.stream` with new input starting a fresh run (the gateway relies on the same behavior). The runner spec uses scripted non-refund routes, so this multi-turn-after-interrupt path has not run in the eval. If LangGraph resumed or errored instead, the case would record an error rather than the duplicate-request outcome. Not reproduced.
**Suggested fix:** Confirm on the first live run (`--ids adv-13`), or add a runner spec with a refund route that pauses and a second turn. Nothing else changes.
**Resolution:** 2026-10-03 fix/bound-database-connect-time-and-test-paused-thread-second-turn: a `run.spec.ts` case drives the real graph with a refund route. The first turn pauses with `approval_required`; a second turn on the paused thread ends with one `final`, `pending_approval`, no `approval_required`, no error, and the duplicate-request answer, so the open request is reused. No live provider run. Awaiting `/audit` re-review. Closed 2026-10-03 by /audit current: the new `run.spec.ts` case runs the real graph; a first-turn `approval_required` implies `pendingRefund` is set and the thread pauses at `await_approval`, and the second turn ends with one `final`, `pending_approval`, no `approval_required`, no error and the duplicate-request answer. The eval specs passed three runs in a row. The repair introduced no new defect. No live provider run of `adv-13`.
