# Fix: Honor client disconnect in the agent loop and tool calls

**Type:** Fix
**Status:** verified
**Branch:** fix/honor-client-disconnect-in-agent-loop
**Fixes:** F-06

## The problem

Feature 1b requires aborting the agent when the client disconnects. The controller
([chat.controller.ts](apps/orderops-agent/src/chat/chat.controller.ts)) aborts an
`AbortController` on `res` close and passes the signal to `ChatService.reply`, but:

- The tool loop in [chat.service.ts](apps/orderops-agent/src/chat/chat.service.ts)
  never checks the signal itself; it relies on the model call throwing. A stubbed
  or non-abort-aware model keeps running further turns and tools after the client
  left.
- `OrdersClient` fetches use only `AbortSignal.timeout(5000)`
  ([orders.client.ts](apps/orderops-agent/src/chat/orders.client.ts)), so an
  in-flight tool call runs up to 5 s after disconnect.
- No test exercises the disconnect path.

## The fix

- In `runToolLoop`, call `signal.throwIfAborted()` at the start of each model turn
  and before each `runTool`, so no further model turns or tools start after an
  abort. The existing `catch` in `reply` already turns the throw into one terminal
  `error` event (the controller drops it once aborted).
- Thread the request signal into the tools: `createOrderTools(client, token,
  seenOrderIds, signal)` passes it to `OrdersClient.listOrders/getOrder`, which
  combine it with the timeout via `AbortSignal.any([signal, AbortSignal.timeout(...)])`.
  A disconnect then cancels the in-flight fetch (it lands in the existing
  `unavailable` branch, which is discarded).
- No new abstraction or dependency. Keep the `signal` parameter required in
  `createOrderTools` and the client methods (one caller each) so it cannot be
  forgotten; update the specs that call them.
- Must not break: normal event order, `unknown_tool` handling, the turn limit,
  and the single `final`-or-`error` terminal event.

## Build steps

- [x] 1. Add the abort checks to `runToolLoop` and a service test that aborts the
  signal after the first tool call and asserts no further model turn runs and the
  stream ends with exactly one `error` event.
  **Done when:** the new test passes, and fails if the `throwIfAborted` calls are
  removed.
- [x] 2. Pass the signal through `createOrderTools` into `OrdersClient`, and add an
  `orders.client.spec.ts` test that aborting the caller signal rejects the fetch
  promptly and returns `unavailable`.
  **Done when:** the fetch mock receives a signal that becomes aborted when the
  caller signal aborts, and the existing client and chat tests still pass.

## Verify

- `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, per-app
  `npx tsc -p apps/<app>/tsconfig.app.json --noEmit`, `npm run lint`.
- Optional live check: start `POST :3000/chat`, drop the connection mid-stream, and
  confirm no further orders-service requests are logged after the disconnect.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2927,"specSha256":"629bf01db41e88749b37926a33740666049d38b638401fa3575dd243dc348fb7","branch":"refs/heads/fix/honor-client-disconnect-in-agent-loop","head":"6b31369c13d80e28b2202587259a8db48d306c77","baseRef":"refs/heads/master","baseCommit":"6b31369c13d80e28b2202587259a8db48d306c77","sourceTree":"fb61098a0b2b8a972ca1b0af518f30a3d06575bb","absentOptional":[]} -->

## Findings

### honor-client-disconnect-in-agent-loop/F-06 [P3] closed - Client-disconnect abort is untested and does not reach tool HTTP calls

**File:** apps/orderops-agent/src/chat/chat.controller.ts:32
**Found:** 2026-09-28 by /audit independent (scope: current; lens: tests, performance)
**Why it matters:** Step 3 requires aborting the agent via `AbortController` on client disconnect. The signal is passed to model calls, but no unit or e2e test exercises the disconnect path, and `OrdersClient` fetches use only `AbortSignal.timeout(5000)` (orders.client.ts:42), so an in-flight tool call keeps running for up to 5 s after the client leaves. Bounded, so low impact, but the spec'd behavior is unproven.
**Suggested fix:** Add a service test that aborts the signal mid-loop and asserts no further model turns run; optionally pass the request signal into the tools (`AbortSignal.any([signal, AbortSignal.timeout(...)])`). No current requirement is lost.
**Resolution:** runToolLoop checks the signal before each model turn and tool run; the signal now reaches OrdersClient fetches via AbortSignal.any. Tests added in chat.service.spec.ts and orders.client.spec.ts. Fixed in fix/honor-client-disconnect-in-agent-loop. Re-reviewed by /audit 2026-09-30: abort checks sit before each model turn and tool run, the signal reaches OrdersClient via AbortSignal.any (Node 22 supports it), the new tests fail without the checks; no new defect.
