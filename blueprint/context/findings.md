# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-06 [P3] open - Controller `finally { done() }` and the throw path have no test

**File:** apps/orderops-agent/src/chat/chat.controller.ts:60
**Found:** 2026-10-19 by /audit independent current (scope: current; lens: tests)
**Why it matters:** The drain depends on the controller calling `done()` on every exit, including when `chat.reply` throws. The unit specs call `done()` by hand, and no spec exercises the controller, so removing the `try/finally` would leave all tests green while shutdown silently waits the full 5 s timeout and then loses the trace race again.
**Suggested fix:** Add a small controller or e2e test where `chat.reply` throws or the client aborts, asserting the `done` returned by `track` was invoked (or that `beforeApplicationShutdown` resolves without hitting the timeout).
