# Fix: Group cost report by customer and thread

**Type:** Fix
**Status:** verified
**Branch:** fix/group-cost-report-by-customer-and-thread
**Fixes:** F-10

## The problem

`npm run report:traces` computes cost per conversation with
`GROUP BY t."threadId"`
([report-traces.ts](apps/orderops-agent/src/trace/report-traces.ts#L38)).
`ChatTrace.threadId` is the client-supplied thread uuid; the real conversation key
is the customer plus that uuid (`threadKey(customerId, threadId)`). Two customers
using the same uuid are separate conversations, but the query merges them, which
skews the conversation count, average and max.

## The fix

Group by `t."customerId", t."threadId"` and select `customerId` too. Add
`customerId` to `ConversationRow` in `report.ts` so the row type matches the query
(the formatter itself only counts rows, so its output logic is unchanged). Nothing
else changes.

Also correct a ledger slip while the ledger is being edited by this work: F-10's
`**Resolution:**` line wrongly holds the F-11 repair note (written there by mistake
when F-11 was marked fixed). Clear it so F-10's resolution only describes this fix.

## Build steps

- [x] 1. Change the query and row type, update the report spec fixtures
  (`customerId` on each conversation row).
  **Done when:** `npm test`, `npx tsc -p apps/orderops-agent/tsconfig.app.json
  --noEmit`, `npm run typecheck:spec` and `npm run lint` pass, and, with the dev
  database up, two throwaway traces with the same `threadId` but different
  `customerId` make `npm run report:traces` print `conversations  2` (the old
  query printed 1). Delete the throwaway rows afterward. If the database is not
  running, say the live check was not run.

## Verify

- The live check above is the proof; the SQL is not covered by a unit test because
  the repository has no database-backed test harness for the report.
- `/audit` re-reviews F-10 (marked `fixed` by `/implement`) before it closes.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":1951,"specSha256":"429d7fb4fd464f8b00fa1eb8e4759d053f3fc3919d4f8e9f96afdcbadc3763cb","branch":"refs/heads/fix/group-cost-report-by-customer-and-thread","head":"c8b488518397f95eae67aaa754ba7947d0b211e9","baseRef":"refs/heads/master","baseCommit":"c8b488518397f95eae67aaa754ba7947d0b211e9","sourceTree":"baae78465ef1754e5f302448764038fbc5b11b99","absentOptional":[]} -->

## Findings

### group-cost-report-by-customer-and-thread/F-11 [P3] closed - Trace write is awaited on the response path with no time bound

**File:** apps/orderops-agent/src/chat/chat.service.ts:170
**Found:** 2026-10-03 by /audit independent (scope: current; lens: performance)
**Why it matters:** `reply()` awaits `recordTrace` in `finally`, and the controller only ends the SSE response after the generator finishes. A slow or unreachable database (pool connect wait) therefore holds the stream open after the `final` event, even though a failed write is already best-effort. Errors are swallowed but latency is not bounded. Unverified under a real database stall.
**Suggested fix:** Start the write without awaiting it (keep the existing catch and log), or race it against a short timeout. Nothing is lost; tests that expect the write after the stream would need to await the store call.
**Resolution:** Closed 2026-10-03 by /audit current (re-review of c8b4885): `reply()` now starts `recordTrace` with `void`, so the stream no longer waits on the write; `recordTrace` still catches every error. The never-settling-store spec covers the original hang and passes (245 tests). The repair introduced no new defect in this file; one related lead is tracked as F-12.
