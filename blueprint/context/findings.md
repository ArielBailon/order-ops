# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-12 [P3] unverified - Unbounded pending trace writes if the database hangs

**File:** apps/orderops-agent/src/chat/chat.service.ts:167
**Found:** 2026-10-03 by /audit (scope: current; lens: performance)
**Why it matters:** Trace writes are now fire-and-forget. `PrismaService` builds `PrismaPg` with only a connection string (libs/prisma/src/prisma.service.ts:10) and `pg` pools have no connection timeout by default, so if the database accepts no connections and does not refuse them (a network black hole), each chat request leaves one pending write holding its trace record, and they accumulate for as long as the stall lasts. A refused connection fails fast and is unaffected. Not reproduced.
**Suggested fix:** Only if it matters in practice: give the adapter a `connectionTimeoutMillis` in `PrismaService`. Nothing else changes.
**Resolution:**

### F-14 [P3] unverified - Second turn on a thread paused for approval is untested

**File:** evals/dataset.json (case adv-13)
**Found:** 2026-10-03 by /audit (scope: current; lens: tests)
**Why it matters:** `adv-13` sends a second refund message on a thread the first turn paused at `await_approval`, relying on `graph.stream` with new input starting a fresh run (the gateway relies on the same behavior). The runner spec uses scripted non-refund routes, so this multi-turn-after-interrupt path has not run in the eval. If LangGraph resumed or errored instead, the case would record an error rather than the duplicate-request outcome. Not reproduced.
**Suggested fix:** Confirm on the first live run (`--ids adv-13`), or add a runner spec with a refund route that pauses and a second turn. Nothing else changes.
**Resolution:**
