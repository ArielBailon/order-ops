# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-05 [P3] open - Fact merge is a read-modify-write, so concurrent turns of one customer can lose facts

**File:** apps/orderops-agent/src/agent/agent.graph.ts:136
**Found:** 2026-10-01 by /audit (scope: current; lens: quality)
**Why it matters:** `remember` reads the facts, merges, then replaces the whole array. Two simultaneous requests from the same customer (different threads or two tabs) can overwrite each other and drop a just-extracted fact. The spec excludes only same-thread concurrency. Impact is a lost note, not corruption.
**Suggested fix:** Accept as a documented limitation, or merge inside one Prisma transaction. No current requirement is lost either way.
**Resolution:**
