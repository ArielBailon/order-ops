# Feature: Mock services and login

**From build-plan:** feature 1a
**Build attempt:** 1
**Status:** verified
**Branch:** `feature/mock-services-and-login`

## Goal

Stand up the two mock microservices on Postgres (via Prisma) with seed data, a
gateway login endpoint that issues JWTs, and token validation in both services so
each request only ever sees the caller's own customer and order data. This is the
authenticated, ownership-scoped foundation that 1b's agent tools call with the
user's token.

## In scope

- Prisma models `Customer` and `Order` (plus enums), first migration, and a
  seed script with a small, varied dataset.
- A shared Nest library for the Prisma client, and one for auth primitives
  (JWT verification guard, current-customer decorator, password hashing, Zod
  validation pipe), since two or more apps need each.
- `customers-service`: credential check endpoint and `GET /customers/me`.
- `orders-service`: `GET /orders` and `GET /orders/:id`, scoped to the caller.
- Gateway (`orderops-agent`): `POST /auth/login` that checks credentials with
  `customers-service` and returns a signed JWT.
- Env config per app via `@nestjs/config` with Zod-validated env, distinct
  default ports, `.env.example` additions.
- Removal of the scaffold "Hello World" controllers/services and their tests,
  replaced by real ones.

## Out of scope

- Chat endpoint, SSE, LangChain tools, structured output (feature 1b).
- Refund data and operator role/approval (feature 4).
- Swagger, token refresh/revocation, registration, password reset, login rate
  limiting, CORS, and any gateway proxy of order/customer endpoints.
- Deployment and CI (`/ci`, feature 8).

## Build loop

Build one small step at a time. `workflow.stepReview` is `feature`: one review
packet after all steps, no per-step approval pause. `workflow.checkpointCommits`
is `disabled`: no checkpoint commits. `/complete` makes the final feature commit.
Never accept a review packet you have not read; split any diff that is too large
to review.

## Build steps

- [x] **Step 1 - Prisma data layer and seed** - Install `@prisma/adapter-pg`
  and `pg` (and `tsx` only if Node's type stripping cannot run the seed). Add a
  Nest library `libs/prisma` (`nest g library prisma`, alias `@app/prisma`) with
  an injectable `PrismaService` built on the pg driver adapter and
  `DATABASE_URL`. Point the Prisma generator output inside that library
  (`libs/prisma/src/generated`) so apps import it within their compile roots;
  update `.gitignore` for the new generated path. Define `Customer`, `Order`,
  `CustomerTier`, `OrderStatus` per Data / contracts, create migration `init`,
  and a seed (`prisma/seed.ts`, wired in `prisma7.config.ts`) that upserts the
  fixed dataset idempotently. Check first that the rspack build bundles the
  generated client and adapter; if it cannot, stop and report rather than
  switching builders. *Done when:* `npx prisma migrate dev` applies `init` on
  the compose database, `npx prisma db seed` run twice leaves 3 customers and 7
  orders (verified with psql), and all three apps still build and typecheck.
- [x] **Step 2 - Shared auth library** - Install `@nestjs/jwt`. Add
  `libs/auth` (alias `@app/auth`) with: `hashPassword` / `verifyPassword` using
  `node:crypto` scrypt and `timingSafeEqual`; `JwtAuthGuard` that requires
  `Authorization: Bearer <token>`, verifies HS256 with `JWT_SECRET`, and exposes
  `{ customerId }` from `sub`; a `@CurrentCustomer()` param decorator; a
  `ZodValidationPipe`. *Done when:* unit tests pass for hash round trip, wrong
  password, malformed stored hash, and guard cases (missing header, non-Bearer
  scheme, bad signature, expired token, valid token sets `customerId`).
- [x] **Step 3 - customers-service** - Replace the scaffold controller/service
  with a `customers` module: `POST /auth/verify-credentials` and
  `GET /customers/me` (guarded). Add `ConfigModule` with Zod-validated env
  (`DATABASE_URL`, `JWT_SECRET`, `CUSTOMERS_SERVICE_PORT` default 3002) and
  import `@app/prisma`. *Done when:* unit tests cover valid credentials,
  unknown email, wrong password, invalid body (400), and `/customers/me`
  returning only the token subject's profile without `passwordHash`; e2e test
  with a faked `PrismaService` covers 200/401/400 over HTTP.
- [x] **Step 4 - orders-service** - Replace the scaffold with an `orders`
  module: `GET /orders` and `GET /orders/:id`, both guarded, every query
  filtered by `customerId` from the token. Env: `DATABASE_URL`, `JWT_SECRET`,
  `ORDERS_SERVICE_PORT` default 3001. *Done when:* unit tests cover list scoped
  to the caller (newest first), own order found, another customer's order and a
  nonexistent id both 404 with the same body, and serialization of decimals and
  dates; e2e test with a faked `PrismaService` covers 200/401/404.
- [x] **Step 5 - Gateway login** - Replace the gateway scaffold with an `auth`
  module: `POST /auth/login` validates the body, calls
  `CUSTOMERS_SERVICE_URL/auth/verify-credentials` with native `fetch`, and on
  success signs a JWT. Env: `JWT_SECRET`, `CUSTOMERS_SERVICE_URL` (default
  `http://localhost:3002`), `PORT` default 3000. *Done when:* unit tests (fetch
  mocked) cover success (token verifies with the secret, `sub` = customer id,
  `exp` = `iat` + 3600), invalid credentials (401), invalid body (400), and
  customers-service unreachable or 5xx (503, no upstream detail leaked).
- [x] **Step 6 - Live flow and docs** - Add new vars to `.env.example`
  (`JWT_SECRET`, `CUSTOMERS_SERVICE_URL`, and the three port vars), and update
  the Commands section of `AGENTS.md` (migrate, seed, run each app, seed login
  credentials location). *Done when:* with compose up, migrated and seeded, and
  all three apps running: login as a seed customer returns a token;
  `GET /customers/me` and `GET /orders` on the services return only that
  customer's data; that customer requesting another customer's order id gets
  404; requests without or with a tampered token get 401; wrong password gets
  401. Full gate green: `npm test`, `npm run test:e2e`, `npm run lint`, `tsc`
  per app, `nest build` per app.

## Files / areas

- `prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`,
  `prisma7.config.ts`, `.gitignore`
- `libs/prisma/` (new), `libs/auth/` (new); `nest-cli.json`, `tsconfig.json`
  path aliases (updated by `nest g library`)
- `apps/customers-service/src/` (customers module, main, root module), its
  `test/app.e2e-spec.ts`
- `apps/orders-service/src/` (orders module, main, root module), its
  `test/app.e2e-spec.ts`
- `apps/orderops-agent/src/` (auth module, main, root module), its
  `test/app.e2e-spec.ts`
- Removed: scaffold `*.controller.ts`, `*.service.ts`, `*.controller.spec.ts`
  in all three apps
- `.env.example`, `AGENTS.md` (Commands), `package.json` (deps)

## Data / contracts

**Persistence** (one Postgres database, one Prisma schema; ownership by
convention: `customers-service` only reads/writes `Customer`, `orders-service`
only `Order`).

- `CustomerTier` enum: `standard`, `premium`
- `OrderStatus` enum: `pending`, `processing`, `shipped`, `delivered`, `cancelled`
- `Customer`: `id` String PK (seed-provided, e.g. `cus_ana`), `name` String,
  `email` String unique (stored lowercase), `tier` CustomerTier default
  `standard`, `passwordHash` String, `createdAt` DateTime default now
- `Order`: `id` String PK (seed-provided, e.g. `ORD-1001`), `customerId` String
  FK -> Customer (indexed), `items` Json, `total` Decimal(10,2), `status`
  OrderStatus, `createdAt` DateTime, `shippedAt` DateTime?, `deliveredAt`
  DateTime?
- `items` JSON shape: array of `{ sku: string, name: string, quantity: int >= 1,
  unitPrice: string (decimal, 2 places) }`; validated with Zod when read.
- `passwordHash` format: `scrypt$<saltHex>$<hashHex>` (16-byte random salt,
  64-byte key). Never returned by any endpoint or logged.
- Seed: 3 customers (at least one per tier), 7 orders covering every status,
  one customer with no orders. One shared dev password for all seed customers,
  documented in the seed file and `AGENTS.md` only (dev data, not a secret).
  No create/update/delete endpoints; data changes only via seed.

**JWT**: HS256 signed with `JWT_SECRET` (required, min 32 chars, validated at
startup in every app). Claims: `sub` = customer id, `iat`, `exp` = `iat` + 3600
s. No refresh. The only trusted actor source in the services is the verified
`sub`; no endpoint accepts a customer id from the client.

**Endpoints** (errors use Nest's default `{ statusCode, message, error }` body):

| App (default port) | Endpoint | Auth | Success | Errors |
| --- | --- | --- | --- | --- |
| gateway (3000) | `POST /auth/login` body `{ email, password }` | none | 200 `{ accessToken, tokenType: "Bearer", expiresIn: 3600 }` | 400 invalid body; 401 generic `Invalid credentials` (same for unknown email and wrong password); 503 when customers-service is unreachable or errors |
| customers-service (3002) | `POST /auth/verify-credentials` body `{ email, password }` | none (internal, local-only mock) | 200 `{ customerId }` | 400 invalid body; 401 generic |
| customers-service (3002) | `GET /customers/me` | Bearer JWT | 200 `{ id, name, email, tier }` | 401 |
| orders-service (3001) | `GET /orders` | Bearer JWT | 200 `Order[]` for the caller, newest `createdAt` first, empty array allowed | 401 |
| orders-service (3001) | `GET /orders/:id` | Bearer JWT | 200 `Order` | 401; 404 `Order not found` when missing or owned by someone else (identical response) |

`Order` response: `{ id, customerId, items, total, status, createdAt, shippedAt,
deliveredAt }`; `total` and `unitPrice` as 2-decimal strings, dates as ISO 8601
UTC strings or `null`.

Request body validation (Zod): `email` valid email, trimmed and lowercased;
`password` non-empty string, max 128 chars.

## Testing

- Runner: Vitest (`npm test` for `*.spec.ts`, `npm run test:e2e` for
  `*.e2e-spec.ts`). The test gate is active for logic-bearing steps.
- Unit: password hashing/verification, `JwtAuthGuard`, Zod pipe, login service
  (fetch mocked), customers service, orders service ownership filtering and
  serialization (PrismaService mocked with `vi.fn()`).
- e2e: each app booted with `Test.createTestingModule`, `PrismaService`
  overridden by an in-memory fake, and HTTP asserted with supertest. They must
  not require Docker.
- Live: Step 6's curl flow against the seeded compose database is the only
  evidence for real Prisma queries and the migration; record the observed
  output.

## Notes for the AI

- ESM + `nodenext`: relative imports end in `.js`. Libraries are imported via
  the `@app/*` aliases that `nest g library` adds.
- The rspack builder only transpiles; run `tsc -p apps/<app>/tsconfig.app.json
  --noEmit` for each app. Library code under `libs/` must typecheck through the
  apps that import it.
- Read env only through `ConfigService`; fail fast at startup on invalid env.
- Never trust a client-supplied customer id; scope every query by the verified
  `sub`. Do not reveal whether an email exists or an order id belongs to
  someone else.
- The scaffold `main.ts` files in the services read lowercase `process.env.port`;
  replace with the app's configured port.
- Use `npx -y npm@11 install` for dependency installs (npm 10.9.3 crashes on
  this project).
- Keep tests offline: no real network calls between apps in unit/e2e tests.

## Open questions

None blocking. Decisions made in this spec that you should confirm during
review, since they become persisted data or contracts:

- `OrderStatus` and `CustomerTier` values above (the plans do not define them;
  feature 4's refund rules will build on `OrderStatus`).
- `Customer.passwordHash` is a field that project-plan section 4 does not list;
  it follows from the login endpoint you chose. Add it to the plan if you want
  the plan to stay exhaustive.
- One shared database and Prisma schema for both mock services, with a
  cross-service FK (`Order.customerId` -> `Customer.id`), rather than one
  schema/database per service.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":12062,"specSha256":"c31bfab70486cdd2995c9fa51035a489cc9616af9a69820be4de33fb3970aa08","branch":"refs/heads/feature/mock-services-and-login","head":"d115b90ba67cdf887d1693ae3ff1627c256325f2","baseRef":"refs/heads/master","baseCommit":"d74672a6ba1fb74ac4e154fe8dff522912c15e4d","sourceTree":"0d4090aca9bfc6a7d94db2d59f6a62bf20ee88e9","absentOptional":[]} -->

## Independent review

**Status:** passed
**Target commit:** d115b90ba67cdf887d1693ae3ff1627c256325f2
**Base commit:** d74672a6ba1fb74ac4e154fe8dff522912c15e4d
**Base ref:** master
**Spec hash:** c31bfab70486cdd2995c9fa51035a489cc9616af9a69820be4de33fb3970aa08
**Prepared by:** claude
**Builder model:** claude-opus-5-5[1m]
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-09-27T03:01:32Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-opus-5-5[1m]
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-09-27T03:05:06Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

### Handoff

Review the active spec and the complete `<base>..<target>` delta in a fresh
session or isolated subagent without the builder conversation. Run all Audit lenses from scratch.
Run Check when required above. Do not edit product code, accept findings, or
reuse the existing findings as the review scope.

### Commands

- `npm test`: pass (6 files, 35 tests)
- `npm run test:e2e`: pass (3 files, 15 tests)
- `npm run lint`: pass
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/orders-service/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/customers-service/tsconfig.app.json --noEmit`: pass
- `npx nest build orderops-agent`: pass
- `npx nest build orders-service`: pass
- `npx nest build customers-service`: pass
- Reviewer-side `tsc` over all app and lib files including specs (scratch tsconfig outside the repo): fail, 3 x TS2307 `supertest/types` in e2e files (F-02)

### Evidence

- Preconditions: HEAD = Target commit; `git merge-base master HEAD` = Base commit; SHA-256 of raw `blueprint/context/current-feature.md` = Spec hash (tracked spec, no snapshot); only `blueprint/context/review.md` differed from the target before review
- Reviewed the full `d74672a..d115b90` delta (67 files, lockfile inspected by manifest only) against the verified spec: libs/auth, libs/prisma, all three apps' src and e2e tests, prisma schema, migration, seed, config, `.env.example`, AGENTS.md
- Ownership: every order query is scoped by the verified JWT `sub` (`findMany`/`findFirst` with `customerId`); foreign and missing orders return an identical 404; `/customers/me` selects no `passwordHash`
- Auth: HS256 pinned on sign and verify, `sub` required, JWT_SECRET min 32 validated at startup in every app, scrypt with `timingSafeEqual`, dummy hash equalizes unknown-email cost, gateway 503 leaks no upstream detail
- No skipped, focused, or placeholder tests found

### Findings

- F-01 [P3] open - LoginService throws HTTP exceptions from the service layer
- F-02 [P3] open - Spec and e2e files are never typechecked
- F-03 [P3] open - Coding standards are stale after this feature
- F-04 [P2] unverified - Unauthenticated credential check listens on all interfaces

### Remaining risk

- Live Step 6 flow (real Postgres, migration, seed, real Prisma queries and cross-app login) was not re-run by the reviewer; Docker services were not started, so real query behavior rests on the builder's recorded live evidence
- `/check` was not run (not required)
- No dependency vulnerability scan was run; lockfile changes were not audited against advisories
- No browser tests are declared (API-only project)
