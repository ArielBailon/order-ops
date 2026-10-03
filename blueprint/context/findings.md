# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-10 [P3] open - Conversation cost report groups by thread id alone

**File:** apps/orderops-agent/src/trace/report-traces.ts:42
**Found:** 2026-10-03 by /audit independent (scope: current; lens: quality)
**Why it matters:** `ChatTrace.threadId` is the client-supplied thread uuid, while the checkpoint key is prefixed with the customer id, so two customers using the same uuid are separate conversations. The per-conversation cost query groups by `threadId` only and would merge them, skewing the conversation count, average and max. Reachable only by a client reusing a uuid; the effect is limited to report accuracy.
**Suggested fix:** `GROUP BY t."customerId", t."threadId"`. Nothing is lost.
**Resolution:**

### F-11 [P3] open - Trace write is awaited on the response path with no time bound

**File:** apps/orderops-agent/src/chat/chat.service.ts:170
**Found:** 2026-10-03 by /audit independent (scope: current; lens: performance)
**Why it matters:** `reply()` awaits `recordTrace` in `finally`, and the controller only ends the SSE response after the generator finishes. A slow or unreachable database (pool connect wait) therefore holds the stream open after the `final` event, even though a failed write is already best-effort. Errors are swallowed but latency is not bounded. Unverified under a real database stall.
**Suggested fix:** Start the write without awaiting it (keep the existing catch and log), or race it against a short timeout. Nothing is lost; tests that expect the write after the stream would need to await the store call.
**Resolution:**
