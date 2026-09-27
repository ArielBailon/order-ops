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

### F-02 [P3] open - Spec and e2e files are never typechecked

**File:** apps/orders-service/tsconfig.app.json:10
**Found:** 2026-09-27 by /audit independent (scope: current; lens: tests)
**Why it matters:** Every app and lib tsconfig excludes `test` and `**/*spec.ts`, the root tsconfig has `files: []`, and Vitest does not typecheck, so none of the 9 test files is covered by the documented `tsc` gate. A reviewer-side typecheck of all app and lib files (scratch tsconfig extending the root one) shows the only errors are in the three rewritten e2e files: `import { App } from 'supertest/types'` does not resolve under `nodenext` (TS2307 at apps/customers-service/test/app.e2e-spec.ts:5, apps/orderops-agent/test/app.e2e-spec.ts:4, apps/orders-service/test/app.e2e-spec.ts:5). It runs only because esbuild drops the type-only import. The import was inherited from the scaffold but kept in this delta.
**Suggested fix:** Change the three imports to `import type { App } from 'supertest/types.js'` (or drop the generic), and add a test typecheck (for example a `tsconfig.spec.json` including spec files, run alongside the per-app `tsc` commands in AGENTS.md). No current requirement is lost.
**Resolution:**

### F-03 [P3] open - Coding standards are stale after this feature

**File:** blueprint/context/coding-standards.md:31
**Found:** 2026-09-27 by /audit independent (scope: current; lens: quality)
**Why it matters:** This feature resolved three items the standards still describe as open or state incorrectly: the port TODO (line 31, services now use 3001/3002 via `ConfigService`), the Prisma client output path (line 61 says `generated/prisma`; it is now `libs/prisma/src/generated`, imported as `@app/prisma`), and the per-service schema TODO (line 65, the spec chose one shared database and schema). Agents read this file before changing code and may follow the wrong path.
**Suggested fix:** Remove the two TODOs, record the one-schema decision, and update the generated client path. Documentation only; no behavior change.
**Resolution:**

### F-04 [P2] unverified - Unauthenticated credential check listens on all interfaces

**File:** apps/customers-service/src/main.ts:7
**Found:** 2026-09-27 by /audit independent (scope: current; lens: security)
**Why it matters:** The spec labels `POST /auth/verify-credentials` "none (internal, local-only mock)", and login rate limiting is out of scope. `app.listen(port)` binds all interfaces, so on a dev machine the endpoint (a full credential oracle with no rate limit, bypassing the gateway) is reachable from the local network, not only localhost. Missing validation: whether "local-only" in the spec was meant as a network-binding requirement or only describes a dev mock.
**Suggested fix:** If local-only means loopback, bind the services with `app.listen(port, '127.0.0.1')` (or a `HOST` env value); otherwise mark this finding invalid with that decision. No current requirement is lost either way.
**Resolution:**
