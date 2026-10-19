# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-05 [P3] open - Trace write for a turn aborted by shutdown races with the database disconnect

**File:** apps/orderops-agent/src/chat/sse-connections.ts:21
**Found:** 2026-10-19 by /implement (fix for F-02; scope: current; lens: quality)
**Why it matters:** With the stack stopped mid-stream (`docker compose stop orderops-agent`), the gateway logged `trace write failed: PrismaClientKnownRequestError` for the aborted turn. A plain client disconnect with the database alive logs no such warning, and a normal turn writes its trace. Ending the streams lets the server close at once, so `onApplicationShutdown` disconnects Prisma while the aborted turn is still unwinding and its fire-and-forget `recordTrace` runs. The write is best effort and aborted turns write no refund row, so the effect is one lost trace per interrupted turn, not data corruption.
**Suggested fix:** Have the shutdown hook wait (bounded, for example a few seconds) for the in-flight turns to settle before the server closes, for example by tracking each handler's completion promise next to its response. Needs a small design decision; accept the lost trace until item 10 (observability) if not worth it.
**Resolution:**
