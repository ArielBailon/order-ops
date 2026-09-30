# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-01 [P3] open - LoginService throws HTTP exceptions from the service layer

**File:** apps/orderops-agent/src/auth/login.service.ts:53
**Found:** 2026-09-27 by /audit independent (scope: current; lens: quality)
**Why it matters:** `coding-standards.md` (Error handling) says services throw typed domain errors and HTTP exceptions are raised at the controller edge. `CustomersService` and `OrdersService` follow that (return `null`, controller maps to 401/404), but `LoginService.verifyCredentials` throws `ServiceUnavailableException` and `UnauthorizedException` directly (lines 53, 56, 60). The gateway service will be reused by 1b agent code, where HTTP exceptions from a service are the wrong shape.
**Suggested fix:** Throw small domain errors (for example `InvalidCredentialsError`, `CustomersServiceUnavailableError`) or return a result from the service and map them to 401/503 in `LoginController`; adjust `login.service.spec.ts` accordingly. Nothing is deleted and no current requirement is lost. Alternatively record an explicit standards exception for thin gateway services.
**Resolution:**

### F-06 [P3] open - Client-disconnect abort is untested and does not reach tool HTTP calls

**File:** apps/orderops-agent/src/chat/chat.controller.ts:32
**Found:** 2026-09-28 by /audit independent (scope: current; lens: tests, performance)
**Why it matters:** Step 3 requires aborting the agent via `AbortController` on client disconnect. The signal is passed to model calls, but no unit or e2e test exercises the disconnect path, and `OrdersClient` fetches use only `AbortSignal.timeout(5000)` (orders.client.ts:42), so an in-flight tool call keeps running for up to 5 s after the client leaves. Bounded, so low impact, but the spec'd behavior is unproven.
**Suggested fix:** Add a service test that aborts the signal mid-loop and asserts no further model turns run; optionally pass the request signal into the tools (`AbortSignal.any([signal, AbortSignal.timeout(...)])`). No current requirement is lost.
**Resolution:**
