# Feature: Operator approval

**From build-plan:** feature 4b
**Build attempt:** 1
**Branch:** feature/operator-approval
**Status:** verified

## Goal

A support operator can review pending refund requests and approve or reject them. A
refund request that passes the rules pauses its chat thread with LangGraph `interrupt()`
and tells the client with an `approval_required` SSE event. An operator decision is
committed in the database first, then resumes the paused thread so the decision is recorded
in the conversation. Operators are customers with a `role` of `operator`, logged in through
the existing `/auth/login`.

## In scope

- Operator identity: a `UserRole` enum (`customer` | `operator`) and `Customer.role` (default `customer`), a seeded operator, the role returned by customers-service `verify-credentials`, and a `role` claim in the JWT signed at login. A token without a valid `role` claim is a customer.
- `OperatorGuard` in `libs/auth`: after `JwtAuthGuard`, requires `role === "operator"`, otherwise 403.
- Operator endpoints on the gateway (all operator-only):
  - `GET /refunds/pending`: pending requests, oldest first, with `id`, `orderId`, `customerId`, `amount`, `reason`, `createdAt`. Operators need this to see the reason before deciding; it is returned as a JSON string value (untrusted customer text, closes F-09).
  - `POST /refunds/:id/approve` and `POST /refunds/:id/reject`: decide a pending request, no body.
- Decision is one atomic conditional update of the row from `pending_approval` to `approved` or `rejected` with `decidedBy` set to the operator's id. Concurrent decisions: exactly one wins, the others get 409. An operator cannot decide their own request (403).
- Graph pause: refund requests that end `pending_approval` now run `refund -> remember -> compact -> await_approval`. `await_approval` calls `interrupt()` as its first statement. Resuming it appends a fixed assistant message with the decision to the thread and ends.
- `approval_required` SSE event emitted by the refund node before the existing `final` event, then the stream ends when the graph pauses.
- `RefundRequest.threadKey` (nullable) stores the checkpoint thread key so a decision can resume the right thread.
- Unit tests, e2e tests, and an `AGENTS.md` note.

## Out of scope

- Operator UI, operator listing of anything other than pending requests, filters, pagination, or notes on a decision.
- Notifying the customer outside chat, and any customer-facing refund status endpoint or deterministic "your refund was decided" push. After a decision the customer's thread holds the decision message, so the agent can answer follow-ups from conversation history; whether it does is not guaranteed.
- Moving money, emails, or changing refund rules from 4a.
- Operator creation or role management endpoints (the operator is seeded).
- Token revocation: a role claim lives until the token expires (1 hour).
- Changing `orders-service`.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement all
steps in order, keeping the project working after each, then present one review packet
for the whole feature. No per-step approval pauses and no checkpoint commits. `/complete`
creates the final commit.

## Build steps

- [x] 1. **Operator role and token claim.**
  - `prisma/schema.prisma`: `enum UserRole { customer operator }`, `role UserRole @default(customer)` on `Customer`, and `threadKey String?` on `RefundRequest`. Migration folder `prisma/migrations/<timestamp>_operator_role/` generated with `prisma migrate diff` (see Notes), checked to contain no `DROP INDEX` of the partial unique index, applied with `prisma migrate deploy`; run `npx prisma generate`.
  - `prisma/seed.ts`: add `role` to seed customers and one operator, `op_sam` / `operator@example.com` / "Sam Operator", same dev password. Idempotent as before.
  - customers-service: `verifyCredentials` returns `{ id, role }` and the endpoint answers `{ customerId, role }`; update its specs.
  - Gateway `LoginService`: parse `role` from the response (Zod) and sign `{ sub, role }`; update its spec.
  - `libs/auth`: `JwtAuthGuard` reads the `role` claim into `request.customer.role` (`"operator"` only when the claim is exactly that string, otherwise `"customer"`); new `OperatorGuard`; export both; specs for guard cases (no role, `customer`, `operator`, junk value).
  - Done when: login as `operator@example.com` returns a token whose payload has `role: "operator"` and as `ana@example.com` has `role: "customer"` (unit-tested with a fake customers-service); guard specs pass; `npx prisma migrate deploy` and `npx prisma generate` apply cleanly; `npm test`, app and spec typecheck (all three apps) and `npm run lint` pass.
- [x] 2. **Store: decide and list.**
  - Extend `RefundStore` and `PrismaRefundStore` in `refund.store.ts`: `create` also accepts and writes `threadKey`; `decide({ id, decision, operatorId })` does `updateMany` with `where: { id, status: 'pending_approval', customerId: { not: operatorId } }`; on zero rows it reads the row once to return `not_found`, `not_pending`, or `own_request`; on success returns the decided record (`id`, `orderId`, `customerId`, `amount` as a two-decimal string, `status`, `threadKey`). `listPending()` returns pending rows oldest first with `amount` as a two-decimal string.
  - Done when: store specs with a fake Prisma client cover success, not found, already decided (including `auto_rejected`), own request, and the exact `where` clause; `npm test`, spec typecheck and lint pass.
- [x] 3. **Operator endpoints.**
  - New module `apps/orderops-agent/src/approvals/` (controller, module; registered in `app.module.ts`) importing `AuthModule`, `RefundsModule` and `ChatModule`; `ChatModule` exports `ChatService`. Controller guarded by `JwtAuthGuard` then `OperatorGuard`. Route param validated with Zod. Domain results map to HTTP: `not_found` 404, `not_pending` 409, `own_request` 403.
  - Approve and reject call `store.decide`, then, only when it succeeded and `threadKey` is set, call `ChatService.resumeRefund(threadKey, customerId, decision)` (added in step 4; a stub that does nothing until then). A resume failure is logged by error name and does not change the response: the committed decision stands. Success response: `{ id, status, decidedBy }`.
  - Done when: e2e (supertest, fake store) shows 401 without token, 403 for a customer-role token, 200 for approve and for reject, 404 unknown id, 409 second decision, 403 own request, and the pending list; `npm test`, `npm run test:e2e`, typechecks and lint pass.
- [x] 4. **Graph pause and resume.**
  - `chat.schemas.ts`: add `{ type: 'approval_required'; data: { refundId: string; orderId: string; amount: string } }` to `AgentEvent` (so `ChatEvent` includes it) and update the comment that calls it reserved.
  - `agent.graph.ts`: state field `pendingRefund` (`{ id, orderId, amount } | null`, last write wins), reset to `null` by the `router` node on every turn. The `refund` node returns `pendingRefund` when its result is a stored `pending_approval` row (new or reused existing open request is not re-paused: only a newly created row sets it) and passes `threadKey` (`config.configurable.thread_id`) to `store.create`; it emits `approval_required` immediately before `final`. After `compact`, a conditional edge goes to `await_approval` when `pendingRefund` is set, otherwise `END`. `await_approval` calls `interrupt({ refundId })` first, validates the resume value with Zod (`{ decision: 'approved' | 'rejected' }`), then returns the fixed decision message as an `AIMessage` and `pendingRefund: null`. Decision texts are fixed constants naming request id, amount and order, never model output.
  - `ChatService.resumeRefund(threadKey, customerId, decision)`: `graph.invoke(new Command({ resume: { decision } }), { configurable: { thread_id: threadKey, customerId, token: '' } })`; callers catch and log.
  - Done when: a graph test with a real `MemorySaver` and fake model shows: a valid refund request emits `approval_required` then `final` and the run ends paused; `resumeRefund(approved)` and `(rejected)` add the matching fixed message to thread state; a new customer message on a still-paused thread runs normally (if LangGraph does not allow this, stop and report); resuming a thread that is no longer paused fails without side effects (caught by the caller); a duplicate open request and an auto-rejected request do not pause. `npm test`, `npm run test:e2e`, typechecks and lint pass.
- [x] 5. **E2E and docs.**
  - Extend `apps/orderops-agent/test/chat.e2e-spec.ts`: the pending refund stream contains `approval_required` before `final` with the new request id; add the new store methods to the fakes in both e2e files.
  - `AGENTS.md`: Commands note for the operator login (`operator@example.com`, same dev password), the three operator endpoints, and the `approval_required` event.
  - Done when: `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck for all three apps, `npm run lint` and `npx nest build orderops-agent` pass.
- [x] 6. **Repair independent-review findings F-13 and F-14.** `resumeRefund` takes the refund id, checks that the thread is paused on `await_approval` for exactly that request (`RefundNotPausedError` otherwise, which the endpoint logs by name), and resumes with `{ refundId, decision }`; `await_approval` validates the id. Done when: a graph test with two pending requests on one thread shows the older request's decision is refused with no state change and the current request's decision is recorded; the no-longer-paused test asserts the rejection; `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck and `npm run lint` pass and F-13 and F-14 are marked `fixed`.
- [x] 7. **Repair independent-review findings F-15 and F-17.** `ChatService.resumeRefund` takes the decided refund (`id`, `orderId`, `amount`). When the thread finished because the customer wrote again, it appends the same fixed decision message with `graph.updateState` (as node `await_approval`); a thread paused on another request, a thread mid-run, and a thread that never ran still throw `RefundNotPausedError`. The thread-key doc comment moves back onto `threadKey`. Done when: graph tests show the message is appended after a later customer turn and a never-run thread is refused; `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck and `npm run lint` pass; AGENTS.md describes the behavior; F-15 and F-17 are marked `fixed`.
- [x] 8. **Repair independent-review finding F-18.** `resumeRefund` treats any thread that is not paused on `await_approval` and has messages as not waiting (finished, or cut off after `final` when the client closed the stream), and appends the fixed decision message, clearing `pendingRefund`. Only a thread paused on another request or one that never ran is refused. Done when: a graph test aborts the stream after `final`, shows a stale non-empty `next` without `await_approval`, and then records the decision; `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck and `npm run lint` pass; F-18 is marked `fixed`.

## Files / areas

- New: `libs/auth/src/operator.guard.ts` and spec, `apps/orderops-agent/src/approvals/` (controller, module, spec), new migration folder
- Changed: `prisma/schema.prisma`, `prisma/seed.ts`, regenerated `libs/prisma/src/generated`, `libs/auth/src/jwt-auth.guard.ts` and spec, `libs/auth/src/index.ts`, `apps/customers-service/src/customers/customers.service.ts`, `customers.controller.ts` and specs, `apps/orderops-agent/src/auth/login.service.ts` and spec, `apps/orderops-agent/src/refunds/refund.store.ts` and spec, `apps/orderops-agent/src/agent/agent.graph.ts`, `refund-route.ts` and spec, `apps/orderops-agent/src/chat/chat.schemas.ts`, `chat.service.ts`, `chat.module.ts`, `apps/orderops-agent/src/app.module.ts`, both e2e files, `AGENTS.md`

## Data / contracts

- `Customer.role UserRole @default(customer)`; JWT payload `{ sub, role, iat, exp }`. A missing or unknown `role` claim means `customer`. `request.customer` is `{ customerId, role }`.
- customers-service `POST /auth/verify-credentials` answers `{ customerId, role }`.
- `RefundRequest.threadKey String?`: the checkpoint thread key (`<customerId>:<threadId>`); null for rows created before 4b, which can still be decided but not resumed.
- Decision transition is only `pending_approval -> approved | rejected`, with `decidedBy` the operator's customer id. `decisionReason` stays null for operator decisions. No other transitions.
- Operator endpoints:
  - `GET /refunds/pending` -> 200 `{ refunds: [{ id, orderId, customerId, amount, reason, createdAt }] }`, `amount` a two-decimal string, `createdAt` ISO string.
  - `POST /refunds/:id/approve` and `/reject` -> 200 `{ id, status: 'approved' | 'rejected', decidedBy }`; 401 no or bad token, 403 not an operator or own request, 404 unknown id, 409 not pending.
- SSE: `event: approval_required` with `{ refundId, orderId, amount }`, sent once, immediately before `final`; `final` still carries `refund: { id, status: 'pending_approval' }`. The `final` event remains the last event of the stream.
- Interrupt payload `{ refundId }`; resume value `{ refundId, decision: 'approved' | 'rejected' }`, accepted only when the thread is paused on that same request.
- Auth boundary: the operator id comes only from the verified JWT; the thread to resume comes only from the stored row, never from the request.

## Testing

- Vitest unit tests: guards, login role claim, store `decide` and `listPending` with a fake Prisma client, graph pause and resume with a real `MemorySaver` and fake model.
- E2E (supertest) with mocked model, services and store, as in steps 3 and 5.
- Not claimed: a live database decision, a live resume through the Postgres checkpointer, and real model behavior. Verify manually through `/check`: apply the migration, seed, log in as `ana@example.com` and `operator@example.com`, create a refund request, approve it as the operator, and check the row and the next chat turn. No seeded order is inside the 30-day window on today's date (delivered 2026-08-06 and 2026-06-05), so the manual check first needs one order's `deliveredAt` moved to a recent date in the database.
- No combined Verify command exists; run the commands named in the steps.

## Notes for the AI

- Read `blueprint/context/coding-standards.md` before changing code. Keep ESM `.js` import suffixes and Zod-at-boundary style.
- Same migration rule as 4a: never let `prisma migrate dev` reset the database. Create the folder with SQL from `prisma migrate diff --from-schema <HEAD schema> --to-schema prisma/schema.prisma --script`, and discard any proposed `DROP INDEX` for the partial unique index on `RefundRequest` (this also checks finding F-11); apply with `prisma migrate deploy`.
- Put `interrupt()` as the first statement of `await_approval`; the node re-executes from its start on resume, so it must have no side effects before it.
- The database decision is the source of truth. Do not make it depend on the checkpointed thread being paused.
- Do not log JWTs, reasons, or full prompts. Do not use em dashes in code comments or reply texts.
- Reuse `JwtAuthGuard`, `ZodValidationPipe`, `threadKey`, and the existing refund store; add no new dependency.

## Open questions

None blocking. Decided with the user: operator role lives on `Customer` and reuses `/auth/login`; the pending customer turn pauses, emits `approval_required` and ends the stream; the customer learns the decision on a later turn of the same thread. Chosen by default: the `GET /refunds/pending` endpoint (needed to show reasons, F-09), the self-approval block, and the best-effort resume.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":15875,"specSha256":"ad65f17d99cff9f5c928dcda4bd0c21fb8dba6a9cdaf0a44c444e5b21463c13c","branch":"refs/heads/feature/operator-approval","head":"f76b920db1263445368584bc57d3746971199f30","baseRef":"refs/heads/master","baseCommit":"dd08302b45355e6e5516dceb31391682fbfbea30","sourceTree":"dcc71e8f0deb2d25633b756e995495e86e6c58bd","absentOptional":[]} -->

## Findings

### 4b/F-13 [P1] closed - Operator decision resumes whichever refund the thread is paused on, so it can announce the wrong request

**File:** apps/orderops-agent/src/agent/agent.graph.ts:224
**Found:** 2026-10-02 by /audit independent (scope: current; lens: quality, tests)
**Why it matters:** The resume value carries only `{ decision }` and `await_approval` builds the message from `state.pendingRefund`, never checking it against the decided row. If a customer files refund A (thread pauses), then in the same thread files refund B for another order (new run, pauses again on B), an operator approving A resumes the B interrupt: the thread records "our team approved your refund ... request B", while B is still `pending_approval` in the database. B's later real decision then resumes a non-paused thread and is silently lost. Reproduced with LangGraph `MemorySaver` and the same router/compact/await_approval shape: log ended with "decision approved for refund B" after approving A, and the second resume did not throw. This breaks the spec contract that the decision is recorded in the conversation and tells the customer a false outcome. No test covers two pending requests on one thread.
**Suggested fix:** Bind the resume to the request: send `{ refundId, decision }` from `resumeRefund` (refund id from the stored row) and in `ChatService.resumeRefund` read `graph.getState()` and resume only when the pending interrupt value's `refundId` equals the decided id (otherwise skip and log by name); also validate `refundId` in `resumeSchema`. Add a graph test with two pending requests on one thread.
**Resolution:** `ChatService.resumeRefund` now takes the refund id, reads the thread state, and throws `RefundNotPausedError` unless the thread is paused on `await_approval` for exactly that request; it resumes with `{ refundId, decision }` and `await_approval` validates the id. A test files two requests in one thread: the older request's decision is refused with no state change, the current request's decision is recorded. Closed 2026-10-02 by independent review of a329704: `resumeRefund` (chat.service.ts:80-95) reads `getState` and refuses unless `next` includes `await_approval` and `pendingRefund.id` equals the decided id; `await_approval` (agent.graph.ts:227-231) also validates the id; the two-request test in chat.service.spec.ts passes. The repair does not reintroduce the wrong-request announcement; the residual concurrent-turn race is tracked separately as F-16.

### 4b/F-14 [P3] closed - Resuming a thread that is no longer paused succeeds silently; its test swallows the outcome

**File:** apps/orderops-agent/src/chat/chat.service.spec.ts:486
**Found:** 2026-10-02 by /audit independent (scope: current; lens: tests)
**Why it matters:** Step 4 says resuming a no-longer-paused thread "fails without side effects (caught by the caller)". In LangGraph JS it does not throw (probe confirmed), so the controller's catch/log path never runs and a dropped decision message leaves no log line. The test uses `.catch(() => {})` and asserts only the last message, so it cannot tell a failure from a silent no-op.
**Suggested fix:** Assert the actual behavior (resolves, state and checkpoint unchanged) and, with the F-13 state check, log when no matching interrupt is pending. No current requirement is lost.
**Resolution:** The no-longer-paused case now throws `RefundNotPausedError` (the endpoint logs it by name) and its test asserts the rejection and unchanged state instead of swallowing it. Closed 2026-10-02 by independent review of a329704: the test now asserts `rejects.toBeInstanceOf(RefundNotPausedError)` and an unchanged last message, and the controller logs the error name.

### 4b/F-15 [P2] closed - Any customer message before the operator decides cancels the pause, so the decision never reaches the conversation

**File:** apps/orderops-agent/src/agent/agent.graph.ts:122
**Found:** 2026-10-02 by /audit independent (scope: current; lens: quality)
**Why it matters:** A new customer turn on a paused thread starts a fresh run (the router resets `pendingRefund`), which discards the pending `await_approval` interrupt. Any follow-up such as "thanks" sent before an operator acts therefore makes the later decision hit `RefundNotPausedError`: the database decision stands, but no decision message is ever added to the thread, and the agent has no other way to learn the outcome (no refund status tool). The spec allows best-effort resume and requires the new turn to run normally, so this is within the letter of the spec, but AGENTS.md (line 346) says the decision "lands in the conversation" without this caveat, and the common flow (customer replies once after filing) silently loses it. Confirmed by the existing test "does not add a decision message when the thread is no longer paused".
**Suggested fix:** Needs a user decision. Either document the limitation in AGENTS.md (no current requirement lost), or, when the thread is no longer paused on that request, append the fixed decision message with `graph.updateState` instead of refusing (adds behavior; keep the same request-id check).
**Resolution:** 2026-10-02 per user decision: `ChatService.resumeRefund` now takes the decided refund (`id`, `orderId`, `amount`). A thread paused on that request is resumed as before. A finished thread with messages gets the same fixed decision message appended with `graph.updateState` (as node `await_approval`). A thread paused on a different request, a thread mid-run, and a thread that never ran still throw `RefundNotPausedError`. Tests: a customer turn after filing, then approval, appends the message; a never-run thread is refused. AGENTS.md updated. Closed 2026-10-02 by independent review of f930c70: `resumeRefund` (chat.service.ts:90-109) resumes a thread paused on the same id, and for a finished thread with messages appends the fixed `REFUND_REPLIES` text with `graph.updateState(..., 'await_approval')`, whose only edge is to END so `next` stays empty; the test "appends the decision message when the customer wrote again before the decision" passes and asserts the message and `next: []`. The decision is stored atomically once, so the append cannot run twice for one request. A paused-on-another-request thread is still refused, as the spec and AGENTS.md state. Residual gaps are tracked separately: aborted runs as F-18, the check-then-write race as F-16.

### 4b/F-16 [P3] accepted - A concurrent customer turn between the paused-state check and the resume can poison the next request's interrupt

**File:** apps/orderops-agent/src/chat/chat.service.ts:87
**Found:** 2026-10-02 by /audit independent (scope: current; lens: quality, tests)
**Why it matters:** `resumeRefund` checks `getState` and then invokes `Command({ resume })` as two separate steps. If the customer files request B in the same thread in between, the resume for A reaches B's `await_approval`, the node throws on the id mismatch (agent.graph.ts:231), and that resume value stays recorded for the task. A standalone LangGraph 1.4.18 `MemorySaver` probe with the same node shape showed the later correct resume for B also throws "mismatch" and leaves `next` empty, so B's decision message is lost too (the controller logs it by name; the stored decisions are unaffected). Only reachable through a narrow same-thread concurrency window, and no test covers the in-node mismatch or invalid-resume path.
**Suggested fix:** Accept as a known race, or make the in-node mismatch non-throwing (for example re-`interrupt` for the pending id instead of throwing) and add a graph test that resumes the node with a mismatched id directly. No current requirement is lost by accepting.
**Resolution:** 2026-10-02 independent review of f930c70: still open; the same check-then-act window now also covers the new append path. `resumeRefund` reads `getState` (chat.service.ts:90) and later calls `graph.updateState` (chat.service.ts:105) with no serialization against a customer turn that starts in between; a run already in flight then writes its later checkpoints from its own lineage, so the appended decision message can be superseded and lost silently. Still a narrow same-thread concurrency window with no data-integrity impact on the stored decision; severity unchanged. Re-checked 2026-10-02 against f76b920: the window is unchanged (`getState` at chat.service.ts:90, `invoke` at :95, `updateState` at :108) and the in-node mismatch throw remains at agent.graph.ts:230; still open. The related same-run window (no customer turn needed) is tracked separately as F-19. 2026-10-02 accepted by the user: same-thread race between an operator decision and the filing run's tail (F-16, F-18, F-19). The stored decision is always correct; only the chat message can be lost, and the controller logs the resume failure. A proper fix (track active runs in ChatService, or move the pause ahead of remember/compact) is larger than this feature needs.

### 4b/F-17 [P3] closed - Thread-key doc comment now sits on RefundNotPausedError

**File:** apps/orderops-agent/src/chat/chat.service.ts:35
**Found:** 2026-10-02 by /audit independent (scope: current; lens: quality)
**Why it matters:** The new `RefundNotPausedError` class was inserted between the existing comment "The customer id comes from the verified JWT, so a client can only reach its own threads." and `threadKey`, so the JSDoc now documents the error class and `threadKey` lost its explanation.
**Suggested fix:** Move the class above the comment (or below `threadKey`). No requirement is lost.
**Resolution:** 2026-10-02: moved `RefundNotPausedError` above the comment so it documents `threadKey` again. Closed 2026-10-02 by independent review of f930c70: chat.service.ts:36-45 now has the error class first and the JSDoc directly on `threadKey`.

### 4b/F-18 [P2] closed - A client that disconnects after `final` leaves the thread stuck before the pause, so the decision is refused as "mid-run"

**File:** apps/orderops-agent/src/chat/chat.service.ts:101
**Found:** 2026-10-02 by /audit independent (scope: current; lens: quality, tests)
**Why it matters:** The refund node emits `approval_required` and `final`, then `remember` and `compact` still run model calls before the graph reaches `await_approval`. The chat controller aborts the run on `res.on('close')` (chat.controller.ts:40), so a client that closes the stream once it has `final` (the event AGENTS.md documents as carrying the result) aborts the run. A standalone LangGraph 1.4.18 `MemorySaver` probe with the same node shape, aborting 10 ms after `final`, threw `AbortError` and left the checkpoint at `next: ["remember"]` with `pendingRefund` still set. `resumeRefund` then sees a non-empty `next` that is not `await_approval`, treats it as a thread mid-run, and throws `RefundNotPausedError`, so the decision message is never recorded in the conversation (the stored decision stands; a later customer turn clears the stale state but the decision has already been refused). No test covers the `next.length > 0` branch.
**Suggested fix:** Either move the pause decision ahead of the post-answer work (for example route `refund` to `await_approval` when `pendingRefund` is set, or make `remember`/`compact` not depend on the request signal once `final` was sent), or treat a stale non-running checkpoint whose `next` excludes `await_approval` like a finished thread and append the message. Add a graph test that aborts after `final` and then decides. No current requirement is lost.
**Resolution:** 2026-10-02 per user decision: `resumeRefund` no longer treats a non-empty `next` as mid-run. Any thread with messages that is not paused on `await_approval` gets the fixed decision message appended (with `pendingRefund` cleared); only a thread paused on another request or one that never ran is refused. A test aborts the stream after `final`, checks the stale `next`, then records the decision. Awaiting re-review. 2026-10-02 closed on the user's decision after the independent review of f76b920 confirmed the original defect is gone (the cut-off-run case appends the decision message and its test passes). The only issue that review raised against the repair is F-19, now accepted.
2026-10-02 independent review of f76b920: the original defect is gone. `resumeRefund` (chat.service.ts:90-117) now appends the fixed message for any thread with messages that is not paused on `await_approval`, and the test "appends the decision message when the client closed the stream after final" passes with a stale `next` that excludes `await_approval`. Not closed, because the repair introduced a new defect: removing the mid-run guard means a decision that arrives while the original run is still in `remember`/`compact` is now appended and then silently overwritten by that run, which also leaves the thread paused on the already-decided request (before the repair this case was refused and logged). Tracked as F-19. Status stays `fixed` (P2, does not block `/complete`) until a later review confirms the repair with F-19 resolved or accepted.

### 4b/F-19 [P2] accepted - A decision made while the filing run is still finishing is appended, then silently overwritten, and the thread stays paused on a decided request

**File:** apps/orderops-agent/src/chat/chat.service.ts:108
**Found:** 2026-10-02 by /audit independent (scope: current; lens: quality, tests)
**Why it matters:** The refund row is inserted (and listed by `GET /refunds/pending`) inside the `refund` node, but the run then still executes `remember` and `compact` (model calls) before it reaches `await_approval`. If an operator decides in that window, `resumeRefund` sees `next: ["remember"]` or `["compact"]`, treats it as a stale cut-off run (the F-18 repair), and calls `graph.updateState(..., 'await_approval')`. The still-running run keeps writing from its own checkpoint lineage, so its later checkpoint supersedes the append. A standalone LangGraph 1.4.18 `MemorySaver` probe with the same node shape (decision applied while `remember` was blocked) ended with `next: ["await_approval"]`, `pendingRefund: {"id":"A"}`, and no decision message: the message is lost with no log line, and the thread is paused on a request that can no longer be decided (a second decision gets 409). Before the F-18 repair this case threw `RefundNotPausedError` and was logged. The stored decision is unaffected, and the next customer turn clears the stale pause. No test covers a decision during an in-flight run.
**Suggested fix:** Distinguish a live run from a cut-off one instead of inferring from `next`: for example, have `ChatService` track thread keys with an active `reply` run (single gateway process) and, for an active thread, refuse with `RefundNotPausedError` (logged) or wait for the run to settle before resuming/appending. Add a graph test that decides while the filing run is blocked in `remember`. Alternatively accept and document the window. No current requirement is lost.
**Resolution:** 2026-10-02 accepted by the user: same-thread race between an operator decision and the filing run's tail (F-16, F-18, F-19). The stored decision is always correct; only the chat message can be lost, and the controller logs the resume failure. A proper fix (track active runs in ChatService, or move the pause ahead of remember/compact) is larger than this feature needs.

## Independent review

**Status:** passed
**Target commit:** f76b920db1263445368584bc57d3746971199f30
**Base commit:** dd08302b45355e6e5516dceb31391682fbfbea30
**Base ref:** master
**Spec hash:** ad65f17d99cff9f5c928dcda4bd0c21fb8dba6a9cdaf0a44c444e5b21463c13c
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** claude-opus-5-5
**Requested execution:** automatic
**Requested at:** 2026-10-02T18:56:54Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-opus-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-02T18:58:38Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

## Commands

- `npm test`: pass (18 files, 194 tests)
- `npm run test:e2e`: pass (5 files, 40 tests)
- `npm run typecheck:spec`: pass
- `npm run lint`: pass
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/orders-service/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/customers-service/tsconfig.app.json --noEmit`: pass

## Evidence

- Freshness: `HEAD` = f76b920, `git merge-base master HEAD` = dd08302, spec SHA-256 matches, only `blueprint/context/review.md` and `blueprint/context/findings.md` differ from the target; the spec is tracked, so no snapshot applies.
- Reviewed the full dd08302..f76b920 delta (32 files): auth role claim and `OperatorGuard`, customers-service `verify-credentials`, login role parsing, refund store `decide`/`listPending`, approvals controller and module, graph pause/resume, `ChatService.resumeRefund`, schema, migration, seed, unit and e2e tests, AGENTS.md.
- Security: operator id comes only from the verified JWT; role is `operator` only for the exact claim; own-request block and pending-only transition are in one conditional `updateMany`; the resumed thread comes only from the stored row; route param is Zod-validated; no reasons, tokens or prompts are logged.
- Standalone LangGraph 1.4.18 `MemorySaver` probe (scratchpad, no project files changed): a decision applied with `updateState(..., 'await_approval')` while the filing run was blocked in `remember` was superseded by the run, which ended paused on `await_approval` with the decided request still pending and no decision message (F-19).
- F-18 re-examined: the cut-off-run case now appends the message and its test passes; left `fixed` because the repair introduced F-19.

## Findings

- Added: F-19 [P2] open
- Updated: F-18 [P2] fixed (repair confirmed, not closed because it introduced F-19), F-16 [P3] open, F-05 [P3] open, F-09 [P3] open, F-11 [P3] unverified, F-12 [P3] open
- Closed: None
- No P0 or P1 finding is open or fixed.

## Remaining risk

- No live database decision or live resume through the Postgres checkpointer was exercised; Check was not required and not run.
- F-11 drift (`prisma migrate diff` against a database) remains unverified.
- F-19 and F-16 are timing windows reproduced only with in-memory probes, not against the running gateway.
- `GET /refunds/pending` is unpaginated by design (out of scope); unbounded growth is unverified at current scale.
