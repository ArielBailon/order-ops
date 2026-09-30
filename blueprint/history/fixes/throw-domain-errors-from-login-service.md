# Fix: Throw domain errors from LoginService

**Type:** Fix
**Status:** verified
**Branch:** fix/throw-domain-errors-from-login-service
**Fixes:** F-01

## The problem

`coding-standards.md` (Error handling) says services throw typed domain errors and
HTTP exceptions are raised at the controller edge. `CustomersService` and
`OrdersService` follow that, but `LoginService.verifyCredentials`
([login.service.ts](apps/orderops-agent/src/auth/login.service.ts)) throws Nest's
`UnauthorizedException` (line 56) and `ServiceUnavailableException` (lines 53, 60)
directly. The service is a plain gateway dependency and the agent code may reuse
it, where an HTTP exception is the wrong shape.

## The fix

- In `login.service.ts`, export two small error classes and throw them instead of
  the HTTP exceptions: `InvalidCredentialsError` (customers-service answered 401)
  and `CustomersServiceUnavailableError` (unreachable, non-OK, or malformed
  answer). Keep the existing warning logs.
- In [login.controller.ts](apps/orderops-agent/src/auth/login.controller.ts), catch
  exactly those two errors and rethrow `UnauthorizedException('Invalid credentials')`
  and `ServiceUnavailableException()`. Any other error propagates unchanged to the
  unexpected-error path.
- The HTTP contract must not change: 401 and 503 bodies stay exactly as today
  (`{ message: 'Service Unavailable', statusCode: 503 }` for 503).
- Update `login.service.spec.ts` to assert the domain errors. The controller mapping
  is proven by the existing e2e tests for 401 and 503 in
  `apps/orderops-agent/test/app.e2e-spec.ts`, which must pass unchanged.
- No new files, dependencies, or shared base class.

## Build steps

- [x] 1. Add the two error classes, throw them from `LoginService`, map them in
  `LoginController`, and update the service spec.
  **Done when:** `login.service.spec.ts` asserts `InvalidCredentialsError` and
  `CustomersServiceUnavailableError`, and the e2e 401 and 503 tests pass unchanged.

## Verify

- `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, per-app
  `npx tsc -p apps/<app>/tsconfig.app.json --noEmit`, `npm run lint`.
- Optional live check: `POST :3000/auth/login` with a wrong password returns 401, and
  with customers-service stopped returns 503.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2264,"specSha256":"1d156b9d2971df90a7e4bce78746c58deab80ce24565a4f7c007ed1062eecd79","branch":"refs/heads/fix/throw-domain-errors-from-login-service","head":"731ddbd074fb80a2fd9ca0ca0d065cedc419957e","baseRef":"refs/heads/master","baseCommit":"731ddbd074fb80a2fd9ca0ca0d065cedc419957e","sourceTree":"f1e011d77156e73a90c10dde4553c7cb99b878db","absentOptional":[]} -->

## Findings

### throw-domain-errors-from-login-service/F-01 [P3] closed - LoginService throws HTTP exceptions from the service layer

**File:** apps/orderops-agent/src/auth/login.service.ts:53
**Found:** 2026-09-27 by /audit independent (scope: current; lens: quality)
**Why it matters:** `coding-standards.md` (Error handling) says services throw typed domain errors and HTTP exceptions are raised at the controller edge. `CustomersService` and `OrdersService` follow that (return `null`, controller maps to 401/404), but `LoginService.verifyCredentials` throws `ServiceUnavailableException` and `UnauthorizedException` directly (lines 53, 56, 60). The gateway service will be reused by 1b agent code, where HTTP exceptions from a service are the wrong shape.
**Suggested fix:** Throw small domain errors (for example `InvalidCredentialsError`, `CustomersServiceUnavailableError`) or return a result from the service and map them to 401/503 in `LoginController`; adjust `login.service.spec.ts` accordingly. Nothing is deleted and no current requirement is lost. Alternatively record an explicit standards exception for thin gateway services.
**Resolution:** LoginService throws InvalidCredentialsError and CustomersServiceUnavailableError; LoginController maps them to 401 and 503 with unchanged bodies (e2e tests unchanged). Fixed in fix/throw-domain-errors-from-login-service. Re-reviewed by /audit 2026-09-30: the service no longer imports HTTP exceptions, the controller maps exactly the two domain errors and rethrows anything else, e2e 401 and 503 bodies are unchanged; no new defect.
