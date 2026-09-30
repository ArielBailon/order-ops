# Fix: Bind internal mock services to loopback

**Type:** Fix
**Status:** verified
**Branch:** fix/bind-internal-services-to-loopback
**Fixes:** F-04

## The problem

`customers-service` and `orders-service` call `app.listen(port)` with no host, so
they bind all interfaces. `POST /auth/verify-credentials` on customers-service is
specified as "none (internal, local-only mock)": an unauthenticated credential
oracle with no rate limit that bypasses the gateway. On a dev machine on a shared
network it is reachable from other hosts. Files: `apps/customers-service/src/main.ts:7`,
`apps/orders-service/src/main.ts:7`.

## The fix

Treat "local-only" as a network-binding requirement (the finding's suggested fix):
listen on `127.0.0.1` in both internal services. Only the gateway (`orderops-agent`,
:3000) stays on all interfaces since it is the public entry point.

- Hardcode `'127.0.0.1'` as the second argument to `app.listen` in the two service
  `main.ts` files. No `HOST` env value: nothing needs a non-loopback bind today.
- Must not break: the gateway reaches the services via `http://localhost:3001/3002`
  (defaults in `apps/orderops-agent/src/env.ts`). `localhost` may resolve to `::1`
  first; Node's default happy-eyeballs (`autoSelectFamily`) should fall back to
  IPv4, but confirm with a real login (it failed with 503, so the fallback was applied). If it fails, change the two URL defaults
  and `.env.example` to `127.0.0.1` and update the e2e URL assertion in
  `apps/orderops-agent/test/chat.e2e-spec.ts:132`.
- Mark F-04 resolved in `findings.md` via `/implement` (status `fixed`).

## Build steps

- [x] 1. Bind `customers-service` and `orders-service` to `127.0.0.1`.
  **Done when:** with all three services running, `POST :3000/auth/login` with a
  seed customer returns an `accessToken`, `GET :3001/orders` with it returns
  200, and `netstat -an` shows :3001 and :3002 listening on `127.0.0.1` only
  (:3000 on `0.0.0.0`/`::`).

## Verify

- `npm run start:all`, then log in and fetch orders as in AGENTS.md Commands.
- `netstat -an | findstr "3001 3002"` shows loopback addresses only.
- `npm test`, `npm run test:e2e`, and `npx tsc -p apps/<app>/tsconfig.app.json --noEmit`
  for both services pass. No new unit test: `main.ts` bootstrap is
  integration-level and exempt from the test gate.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2322,"specSha256":"c48a4acc0f42a25853932173b8a503ed8f14e2452d39e969ce7f1e89735f5123","branch":"refs/heads/fix/bind-internal-services-to-loopback","head":"5d977837bf24ff81303d1d9724074d9769b146f7","baseRef":"refs/heads/master","baseCommit":"5d977837bf24ff81303d1d9724074d9769b146f7","sourceTree":"0fc2e18044a32a845c393a1484127637aec37e9b","absentOptional":[]} -->

## Findings

### bind-internal-services-to-loopback/F-04 [P2] closed - Unauthenticated credential check listens on all interfaces

**File:** apps/customers-service/src/main.ts:7
**Found:** 2026-09-27 by /audit independent (scope: current; lens: security)
**Why it matters:** The spec labels `POST /auth/verify-credentials` "none (internal, local-only mock)", and login rate limiting is out of scope. `app.listen(port)` binds all interfaces, so on a dev machine the endpoint (a full credential oracle with no rate limit, bypassing the gateway) is reachable from the local network, not only localhost. Missing validation: whether "local-only" in the spec was meant as a network-binding requirement or only describes a dev mock.
**Suggested fix:** If local-only means loopback, bind the services with `app.listen(port, '127.0.0.1')` (or a `HOST` env value); otherwise mark this finding invalid with that decision. No current requirement is lost either way.
**Resolution:** customers-service and orders-service now listen on 127.0.0.1; gateway service URLs default to 127.0.0.1 (localhost failed from the gateway with 503). Fixed in fix/bind-internal-services-to-loopback. Re-reviewed by /audit 2026-09-30: both service listens bind 127.0.0.1, gateway is the only public listener, gateway URL defaults, .env.example and the e2e URL assertion are consistent, no new defect found.
