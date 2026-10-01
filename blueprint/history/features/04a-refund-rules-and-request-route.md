# Feature: Refund rules and request route

**From build-plan:** feature 4a
**Build attempt:** 1
**Branch:** feature/refund-rules-and-request-route
**Status:** verified

## Goal

A customer can ask the agent for a refund in chat. The agent works out which order,
amount and reason they mean, then code (not the model) decides: requests that break
the refund rules are stored as `auto_rejected` with a fixed explanation, and valid
ones are stored as `pending_approval`. Every reply about a refund is deterministic
text built from the stored result, and if the agent cannot produce a valid request
the customer gets a fixed fallback message and nothing is stored. Operator approval
is feature 4b.

## In scope

- `refund` route: router intent, graph node, and wiring after the answer into the existing `remember` and `compact` nodes.
- Agentic extraction: the model may use the existing `list_orders` / `get_order` tools to identify the order, then returns a Zod-validated proposal `{ orderId, amount, reason }` through `invokeStructured` (existing bounded retry: 2 attempts).
- Business rules enforced in code, in one pure function with an injectable clock:
  - the order must belong to the caller and have status `delivered` with a `deliveredAt`;
  - the request must be made within 30 days of `deliveredAt` (`policies/returns.md`);
  - `0 < amount <= order.total`; partial amounts allowed, a missing amount means the full order total;
  - no other request for the same order may be `pending_approval`.
- `RefundRequest` storage in the gateway (Prisma, shared Postgres) with a database guard against two open requests for one order.
- Deterministic replies from fixed templates for: submitted, each auto-reject reason, order not found, orders service unavailable, need order id and reason, and agent failure fallback.
- Deterministic fallback: if the refund route's model work fails (`invalid_output` or `agent_error` after retries), emit a `final` with the fallback text instead of an `error` event, store nothing. Client aborts still propagate.
- A refund summary on the `final` event for the refund route.
- Unit tests, an e2e test, and a short `AGENTS.md` note.

## Out of scope

- Operator identity, `interrupt()`, approve/reject endpoints, `approval_required` event, and any transition to `approved` or `rejected` (feature 4b). The enum values exist now but are unused.
- Return shipping fees, damaged-item or wrong-item exceptions, final-sale items, gift cards (not modeled in order data).
- Moving money, emails, notifications, or any refund status lookup or listing endpoint for customers.
- Customer tiers affecting rules.
- Changing `orders-service` or its API.
- The FAQ route still answers refund policy questions.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement all
steps in order, keeping the project working after each, then present one review packet
for the whole feature. No per-step approval pauses and no checkpoint commits. `/complete`
creates the final commit.

## Build steps

- [x] 1. **Refund rules (pure).**
  - New `apps/orderops-agent/src/refunds/refund-rules.ts`: money helpers that work in integer cents (parse `"89.90"` strings, never floats), the `REFUND_WINDOW_DAYS = 30` constant, and `evaluateRefund({ order, amountCents, openRequestExists, now })` returning `{ ok: true }` or `{ ok: false, code }` with `code` one of `not_delivered`, `window_expired`, `amount_exceeds_total`, `open_request_exists` (an order owned by someone else is treated as `not_found` upstream, see step 4).
  - Rule order is fixed: `not_delivered`, `window_expired`, `amount_exceeds_total`, `open_request_exists`; the first failure wins.
  - Done when: a table-driven spec covers every code, the exact window boundary (day 30 accepted, day 30 plus one second rejected), amount equal to total accepted, one cent over rejected, cancelled/shipped/processing/pending rejected, and an order with `status: delivered` but `deliveredAt: null` rejected as `not_delivered`; `npm test`, spec typecheck and `npm run lint` pass.
- [x] 2. **Storage.**
  - Prisma: `enum RefundStatus { pending_approval approved rejected auto_rejected }` and `model RefundRequest` (see Data). Migration created without resetting the database: generate the SQL with `prisma migrate diff` and apply with `prisma migrate deploy` (see Notes). The migration also creates a partial unique index on `("orderId") WHERE "status" = 'pending_approval'`.
  - `apps/orderops-agent/src/refunds/refund.store.ts`: a `RefundStore` interface (`findOpenForOrder`, `create`) with a Prisma implementation that turns a unique-violation on the partial index into an `open_request_exists` result, and a `REFUND_STORE` token; a small module exporting it.
  - Done when: `npx prisma migrate deploy` applies cleanly and `npx prisma generate` succeeds; a unit test with a fake Prisma client shows the unique-violation mapping; `npm test`, app and spec typecheck and lint pass.
- [x] 3. **Router and route type.**
  - Add `refund` to `chatRouteSchema`; update `ROUTER_PROMPT` so requests to get a refund, return an order for money back, or cancel and refund route to `refund`, policy questions about refunds still route to `faq`, and the "requests to perform actions (for example start a refund)" wording under `out_of_scope` is removed. Extend `FinalReply` with an optional `refund: { id, status }` (`status` is `pending_approval` or `auto_rejected`). Until step 4 lands, the graph routes `refund` to a stub that emits the fallback text.
  - Done when: router tests show "I want my money back for ord_1001" classifies as `refund` and "what is your refund policy" as `faq` (scripted model), existing routing tests still pass, and the build typechecks.
- [x] 4. **Refund node.**
  - New `apps/orderops-agent/src/agent/refund-route.ts`:
    1. Run the model with the existing order tools (`createOrderTools`) and a refund system prompt (conversation context included, JWT never in prompts), then ask for the proposal `{ orderId: string | null, amount: money string | null, reason: string (1..500) }` via `invokeStructured`. Proposal prompts treat customer text as data.
    2. `orderId` or `reason` missing: fixed "need order id and reason" reply, store nothing.
    3. Fetch the order with `OrdersClient.getOrder` using the caller's token; never use model-supplied order data. `not_found` (including another customer's order, which orders-service reports as 404) and `unavailable` give fixed replies and store nothing. An order whose `customerId` differs from the JWT customer is treated as `not_found`.
    4. Evaluate rules with the real clock (injectable in tests). On failure, store `auto_rejected` (`decidedBy: "system"`, `decisionReason: <code>`) and reply with the fixed text for that code. For `open_request_exists`, store nothing and reply with the existing request's id instead of creating another row.
    5. On success, store `pending_approval` and reply with the fixed "submitted" text containing the request id, amount, and order id.
    6. Any `ChatAgentError` or model failure in this route becomes the fallback `final` (no stored row). Abort errors are rethrown.
  - Graph: `refund` node and edges `refund -> remember -> compact`; `AgentDeps` gains the refund store and a clock; `ChatService` injects `REFUND_STORE`.
  - Done when: unit tests with the fake model, fake order client and fake store show: valid request stored as `pending_approval` with the right customer id, amount and reason; each rule failure stored as `auto_rejected` with its code and fixed text; full amount used when the model gives none; duplicate open request reuses the id and writes nothing; order not found and unavailable store nothing; model returning invalid output twice produces the fallback `final`, not `error`; aborting the signal still ends with the existing behavior; `npm test`, app and spec typecheck and lint pass.
- [x] 5. **E2E and docs.**
  - Extend `apps/orderops-agent/test/chat.e2e-spec.ts` with a mocked model and orders-service: refund of a delivered order within the window returns a `final` with `route: "refund"` and `refund.status: "pending_approval"`; a refund of an old or non-delivered order returns `auto_rejected`; add the new store override to both e2e files.
  - `AGENTS.md`: one Commands note that `UserMemory` and `RefundRequest` tables come from `npx prisma migrate deploy`, and what the refund `final` fields mean.
  - Done when: `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck, `npm run lint` and `npx nest build orderops-agent` pass.
- [x] 6. **Repair independent-review findings F-06, F-07, F-08 and F-10.** Stop on client abort after the order fetch and before any write, log the proposal failure name, map only unique violations to a duplicate request in the store, and align the router prompt and tests with cancel-and-refund routing. Done when: `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck and `npm run lint` pass and the findings are marked `fixed`.

## Files / areas

- New: `apps/orderops-agent/src/refunds/` (`refund-rules.ts`, `refund.store.ts`, module, specs), `apps/orderops-agent/src/agent/refund-route.ts` and spec
- Changed: `apps/orderops-agent/src/agent/agent.graph.ts`, `router.ts`, `apps/orderops-agent/src/chat/chat.schemas.ts`, `chat.service.ts`, `chat.module.ts`, `chat.service.spec.ts`
- `prisma/schema.prisma` and a new migration folder; regenerated `libs/prisma/src/generated`
- `apps/orderops-agent/test/chat.e2e-spec.ts`, `app.e2e-spec.ts`
- `AGENTS.md`

## Data / contracts

- `RefundRequest` (Prisma, gateway-owned, shared Postgres):
  - `id String @id`, generated by the store as `ref_` plus a UUID (`crypto.randomUUID()`), never client-supplied;
  - `orderId String` FK to `Order.id`; `customerId String` FK to `Customer.id`, taken from the verified JWT and equal to the order's owner;
  - `amount Decimal @db.Decimal(10,2)`, never above the order total;
  - `reason String`, trimmed, at most 500 characters, treated as untrusted text;
  - `status RefundStatus` (`pending_approval` | `approved` | `rejected` | `auto_rejected`);
  - `decidedBy String?` (`"system"` for `auto_rejected`; operator id in 4b);
  - `decisionReason String?` (rule code for `auto_rejected`);
  - `createdAt DateTime @default(now())`;
  - index on `customerId`; partial unique index `orderId WHERE status = 'pending_approval'` (SQL migration only; Prisma does not model partial indexes).
- Proposal schema (Zod): `{ orderId: string | null, amount: /^\d+(\.\d{1,2})?$/ string > 0 | null, reason: string }`. Amounts are strings or integer cents end to end; no floating point arithmetic on money.
- Rule codes and fixed customer replies (exact wording lives in `refund-route.ts` constants): `submitted`, `not_delivered`, `window_expired`, `amount_exceeds_total`, `open_request_exists`, `order_not_found`, `orders_unavailable`, `need_details`, `agent_fallback`. Replies never come from the model and never claim approval.
- `final` event for the route: `{ answer, orderIds: [orderId?], route: "refund", threadId, refund?: { id, status } }`; `refund` is present only when a row was created or an open one was reused. `error` events are not produced for refund-route agent failures.
- Clock: `AgentDeps` takes `now: () => Date` (default `() => new Date()`); tests inject a fixed time.
- Auth boundary: the caller token is used for orders-service calls (ownership enforced there, 404 for others); the customer id for writes comes only from the JWT.

## Testing

- Vitest unit tests for rules (pure), store error mapping (fake client), refund node (fake model, order client, store, fixed clock), router.
- E2E (supertest) with mocked model and services, as in step 5.
- Not claimed: real model extraction quality and a live database write via chat. Verify manually through `/check`: log in as Ana, ask for a refund on a delivered order within 30 days (seed order dates are in June to September 2026, so some may be outside the window on your clock), confirm the `RefundRequest` row, repeat the request to see the duplicate reply.
- No combined Verify command exists; run the commands named in the steps.

## Notes for the AI

- Read `blueprint/context/coding-standards.md` before changing code. Keep ESM `.js` import suffixes and Zod-at-boundary style.
- `prisma migrate dev` reports drift from library-managed tables (`policy_chunks`, checkpoint tables) and asks to reset the database: do not reset. Create the folder `prisma/migrations/<timestamp>_refund_requests/` with SQL from `prisma migrate diff --from-schema <HEAD schema> --to-schema prisma/schema.prisma --script`, append the partial unique index SQL by hand, and apply with `prisma migrate deploy`.
- Rules and replies live in code, never in prompts. The model only proposes; it must not be able to change amount limits, window, or outcome.
- Do not log JWTs, reasons, or full prompts.
- Reuse `createOrderTools`, `invokeStructured`, `OrdersClient`, and the `answered` / `remember` / `compact` flow; do not add a second model or provider abstraction.
- Do not use em dashes in code comments or reply texts.

## Open questions

Non-blocking; defaults above were chosen with the user or from `policies/returns.md`.

- **Decided with the user:** rules are the policy-derived set above; data lives in the gateway; item 4 is split into 4a and 4b.
- **Deferred to 4b:** operator identity (role claim vs separate login), how approval resumes the thread, and any customer-facing status lookup.
- **Chosen by default:** auto-rejected attempts are stored (for audit); "order not found" and "orders unavailable" are not stored; return shipping fee (6.00 USD deducted for non-damaged returns) is not modeled; reason length cap is 500 characters.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":13772,"specSha256":"667bd9577a6af9c94f7d77514b286ce95d7666ad175f51d2cad247f9635b91d2","branch":"refs/heads/feature/refund-rules-and-request-route","head":"f3cdb16b5f9257fef09eefe8597a0b5f24646b32","baseRef":"refs/heads/master","baseCommit":"282a1a4c26f047f435ab3120271cafed922fe3d9","sourceTree":"0a307fcb29d19541bf3e7923a3e89435841272e9","absentOptional":[]} -->

## Findings

### 4a/F-06 [P2] closed - Refund route does not stop on client abort after the proposal step

**File:** apps/orderops-agent/src/agent/refund-route.ts:97
**Found:** 2026-10-01 by /audit independent (scope: current; lens: quality)
**Why it matters:** Only the proposal step is guarded against aborts, but the spec says client aborts still propagate. After the proposal, OrdersClient.getOrder turns an aborted fetch into unavailable, so a cancelled request ends with a normal reply and the graph carries on to remember and compact. An abort after getOrder succeeds does not stop findOpenForOrder or create, so a refund row can still be written for a client that disconnected. The only abort test aborts before the route starts.
**Suggested fix:** Call signal.throwIfAborted() after getOrder and before create, and add a test that aborts during getOrder.
**Resolution:** runRefundRoute calls signal.throwIfAborted() right after getOrder (an aborted fetch is reported as unavailable) and right after findOpenForOrder, before any create. Tests abort during getOrder and during the open-request lookup and assert nothing is stored.
Closed 2026-10-01 by /audit independent (fresh subagent): refund-route.ts:131 and :148 throw on abort before any create, the proposal catch rethrows when signal.aborted, and the two abort tests plus the pre-aborted test pass. No new defect in the repair.

### 4a/F-07 [P3] closed - Proposal failures fall back silently without any log

**File:** apps/orderops-agent/src/agent/refund-route.ts:90
**Found:** 2026-10-01 by /audit independent (scope: current; lens: quality)
**Why it matters:** The catch around the proposal turns every non-abort error into the fallback reply without logging. A misconfigured or failing provider would silently make every refund request fall back.
**Suggested fix:** Log only error.name (no prompts, tokens or reason text).
**Resolution:** The proposal catch logs 'refund proposal failed: <error name>' through a Nest Logger (name only, no prompt, token or reason text); test asserts the exact message.
Closed 2026-10-01 by /audit independent (fresh subagent): refund-route.ts:122 logs only the error name; the test passes an error whose message holds reason-like text and asserts the log omits it. ChatService also logs name only.

### 4a/F-08 [P3] closed - Store maps any failed insert to open_request_exists instead of only unique violations

**File:** apps/orderops-agent/src/refunds/refund.store.ts:61
**Found:** 2026-10-01 by /audit independent (scope: current; lens: security)
**Why it matters:** The catch does not check for a unique violation (P2002). Any failed pending_approval insert becomes 'already has a request' when an open request exists. If the follow-up findOpenForOrder also throws, the original error is lost.
**Suggested fix:** Map only P2002 (or the driver's equivalent) to open_request_exists and rethrow everything else, keeping the original error.
**Resolution:** The store maps only a Prisma P2002 unique violation on a pending_approval insert to open_request_exists (shape confirmed live: PrismaClientKnownRequestError P2002 from the partial index). Other errors, a failed lookup, or a violation with no open request rethrow the original error; tests cover each.
Closed 2026-10-01 by /audit independent (fresh subagent): refund.store.ts:71 maps only P2002 on a pending_approval insert and rethrows the original error otherwise; auto_rejected inserts never look for a duplicate. Store spec covers each branch. No new defect (see F-12 for a redundant test only).

### 4a/F-10 [P3] closed - Router test cannot catch a routing regression

**File:** apps/orderops-agent/src/agent/router.spec.ts:30
**Found:** 2026-10-01 by /audit independent (scope: current; lens: tests)
**Why it matters:** The scripted-model test always answers refund, so it cannot catch a routing regression. The spec wants cancel-and-refund routed to refund, but the new prompt sends 'cancel an order' to out_of_scope.
**Suggested fix:** Assert prompt wording for the cancel-and-refund case, or align the spec and prompt, and drop the scripted-answer test.
**Resolution:** Router prompt now routes cancel-and-get-money-back to refund and a bare cancellation to out_of_scope, matching the spec. The scripted-answer test was replaced by prompt-wording assertions and an input-order test for classifyIntent.
Closed 2026-10-01 by /audit independent (fresh subagent): router.ts prompt routes cancel-and-get-money-back to refund, a bare cancellation to out_of_scope, and policy questions to faq, matching the spec; router.spec.ts asserts that wording and the message order. The tests cannot measure real model routing, which is eval scope.

## Independent review

**Status:** passed
**Target commit:** f3cdb16b5f9257fef09eefe8597a0b5f24646b32
**Base commit:** 282a1a4c26f047f435ab3120271cafed922fe3d9
**Base ref:** master
**Spec hash:** 667bd9577a6af9c94f7d77514b286ce95d7666ad175f51d2cad247f9635b91d2
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** claude-sonnet-5-5
**Requested execution:** automatic
**Requested at:** 2026-10-01T19:40:08Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-01T19:41:41Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

## Commands

- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npm run typecheck:spec`: pass
- `npm run lint`: pass
- `npm test`: pass (17 files, 161 tests)
- `npm run test:e2e`: pass (4 files, 26 tests)

## Evidence

- HEAD, merge base of local master, and raw spec SHA-256 matched the request; only review.md and findings.md differed from the target.
- Reviewed the full 282a1a4..f3cdb16 delta: refund-rules.ts, refund.store.ts, refund-route.ts, graph wiring, router prompt, chat schemas, schema.prisma, the hand-written migration SQL, and all new or changed specs and e2e tests.
- Money is integer cents end to end; MAX_CENTS 9,999,999,999 matches DECIMAL(10,2); the window boundary (day 30 accepted, plus one second rejected) and the fixed rule order are covered by tests.
- customerId comes only from the JWT, the caller token is used for orders-service, and an order owned by someone else is treated as not found; replies are fixed text and model prose is never streamed.
- Abort checks after getOrder and after findOpenForOrder precede any write; the proposal catch rethrows on abort; logs carry error names only.
- F-06, F-07, F-08 and F-10 re-examined against the repaired code and closed; their defects are gone and no new defect was introduced.

## Findings

- F-05 [P3] open (earlier merged feature, untouched)
- F-06 [P2] closed
- F-07 [P3] closed
- F-08 [P3] closed
- F-09 [P3] open (reason and amount come from the model; accepted risk for 4a, quote it to operators in 4b)
- F-10 [P3] closed
- F-11 [P3] unverified (partial unique index only in hand-written SQL; no database was run)
- F-12 [P3] open (duplicate store test and redundant e2e mock reset)

## Remaining risk

- No P0 or P1 finding is open or fixed.
- F-11 is unconfirmed: no database was started, so `prisma migrate diff` drift and the partial index behavior were not re-checked live.
- The model can propose an amount the customer did not name (always capped at the order total and stated in the fixed reply) and the stored reason is untrusted text for operators (F-09).
- Each chat refund attempt that fails a rule stores an auto_rejected row (by design); no rate limit exists, so repeated attempts grow the table.
- Real model extraction and routing quality are not measured by the mocked tests; Check was not required and was not run.
