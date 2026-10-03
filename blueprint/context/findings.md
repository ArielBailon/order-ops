# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-10 [P3] fixed - Conversation cost report groups by thread id alone

**File:** apps/orderops-agent/src/trace/report-traces.ts:42
**Found:** 2026-10-03 by /audit independent (scope: current; lens: quality)
**Why it matters:** `ChatTrace.threadId` is the client-supplied thread uuid, while the checkpoint key is prefixed with the customer id, so two customers using the same uuid are separate conversations. The per-conversation cost query groups by `threadId` only and would merge them, skewing the conversation count, average and max. Reachable only by a client reusing a uuid; the effect is limited to report accuracy.
**Suggested fix:** `GROUP BY t."customerId", t."threadId"`. Nothing is lost.
**Resolution:** 2026-10-03 fix/group-cost-report-by-customer-and-thread: the per-conversation cost query now groups by `t."customerId", t."threadId"`, and `ConversationRow` carries `customerId`. Checked live against the dev database with two throwaway traces sharing a thread id but with different customers: the old query printed `conversations  1`, the new one prints `2`; the rows were deleted afterward. Awaiting `/audit` re-review.

### F-12 [P3] unverified - Unbounded pending trace writes if the database hangs

**File:** apps/orderops-agent/src/chat/chat.service.ts:167
**Found:** 2026-10-03 by /audit (scope: current; lens: performance)
**Why it matters:** Trace writes are now fire-and-forget. `PrismaService` builds `PrismaPg` with only a connection string (libs/prisma/src/prisma.service.ts:10) and `pg` pools have no connection timeout by default, so if the database accepts no connections and does not refuse them (a network black hole), each chat request leaves one pending write holding its trace record, and they accumulate for as long as the stall lasts. A refused connection fails fast and is unaffected. Not reproduced.
**Suggested fix:** Only if it matters in practice: give the adapter a `connectionTimeoutMillis` in `PrismaService`. Nothing else changes.
**Resolution:**
