# Feature: SSE order chat

**From build-plan:** feature 1b
**Build attempt:** 1
**Branch:** feature/sse-order-chat
**Status:** verified

## Goal

An authenticated customer sends one chat message to the gateway and receives a
Server-Sent Events stream in which the agent answers order questions ("where is
my order?") by calling `orders-service` through LangChain tool calling with the
caller's own token. The stream ends with a Zod-validated structured answer. This
feature locks the SSE event contract that items 2-7 build on.

## In scope

- `POST /chat` on the gateway, guarded by the existing `JwtAuthGuard`, body
  validated with Zod, response `text/event-stream`.
- An orders HTTP client in the gateway that calls `GET /orders` and
  `GET /orders/:id` on `orders-service` with the caller's bearer token and
  validates responses with Zod.
- Two LangChain tools with Zod input schemas: `list_orders` (no input) and
  `get_order` (`{ orderId }`). Neither accepts a customer id.
- A bounded tool-calling loop on one Anthropic chat model, streaming text deltas
  as `token` events and each tool invocation as a `tool_call` event.
- A final `withStructuredOutput` call with a Zod schema and one retry, emitted as
  the `final` event.
- Fixed, non-leaking `error` events for agent failures.
- The locked SSE event contract (all five event names, four shapes defined here).
- Gateway env: `ANTHROPIC_API_KEY` (required) and `ORDERS_SERVICE_URL`
  (default `http://localhost:3001`); `.env.example` gains `ORDERS_SERVICE_URL`.

## Out of scope

- LangGraph graph, intent router, FAQ/RAG, and the out-of-scope refusal route
  (item 2). The system prompt keeps the agent on orders, but no code-enforced
  refusal exists yet.
- Multi-turn threads, checkpointer, and memory (item 3). Each request is
  stateless and single-turn.
- Refunds, `approval_required` payload, and `interrupt()` (item 4).
- Provider layer, model routing, and failover (item 5). The model is constructed
  in one place.
- Tracing and cost (item 6), evals (item 7), rate limiting, and any HTML page.
- Open findings F-01 to F-04 from 1a. They are tracked separately; this feature
  does not repair them.

## Build loop

`workflow.stepReview` is `feature`: implement all steps, keeping each one
working and its tests green, then present one review packet for the whole
feature. `workflow.checkpointCommits` is `disabled`: no per-step commits.
`/complete` creates the single feature commit on `feature/sse-order-chat`.

## Build steps

- [x] 1. Contracts, env, and orders client
  - Add `apps/orderops-agent/src/chat/chat.schemas.ts`: the chat request schema,
    the SSE event union, the final-answer schema, and the gateway-side order
    schema (see Data / contracts).
  - Extend `apps/orderops-agent/src/env.ts` with `ANTHROPIC_API_KEY`
    (non-empty string, required) and `ORDERS_SERVICE_URL` (URL, default
    `http://localhost:3001`). Add `ORDERS_SERVICE_URL` to `.env.example`. Set a
    fake `ANTHROPIC_API_KEY` in `apps/orderops-agent/test/app.e2e-spec.ts` so
    existing e2e tests still boot.
  - Add `apps/orderops-agent/src/chat/orders.client.ts`: `listOrders(token)` and
    `getOrder(token, orderId)` using `fetch` with a 5000 ms timeout (same
    pattern as `LoginService`), parsing bodies with the order schema. Results:
    orders on success, `not_found` on 404, `unavailable` on unreachable,
    timeout, any other status, or an invalid body. It logs status only, never
    the token.
  - Done when: `npm test` covers the schemas and every client outcome with
    `fetch` mocked (including that the `Authorization: Bearer <token>` header is
    sent and `orderId` is URL-encoded), existing tests stay green, and
    `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit` passes.

- [x] 2. Tools and agent loop
  - Add `apps/orderops-agent/src/chat/order-tools.ts`: builds `list_orders` and
    `get_order` LangChain tools bound to the request's token (closure, created
    per request). Tool output is JSON: the validated order data, or
    `{ "error": "not_found" | "unavailable" }` so the model can answer
    gracefully.
  - Add `apps/orderops-agent/src/chat/chat.service.ts` and the system prompt
    constant next to it. The service takes the message, token, and an
    `AbortSignal`, and returns an `AsyncIterable` of SSE events:
    1. Loop: stream the tool-bound model; emit `token` for each text delta;
       when the turn ends with tool calls, emit one `tool_call` per call, run
       the tools, append the results, and continue. Stop when a turn has no
       tool calls. At most 4 model turns; exceeding it yields `error`
       (`agent_error`).
    2. Call `withStructuredOutput(finalAnswerSchema)` over the transcript, with
       one retry on a schema failure. Drop any `orderIds` not returned by a
       tool in this request, then emit `final`. Two failures yield `error`
       (`invalid_output`).
    3. Any model or unexpected error yields `error` (`agent_error`). Provider
       messages and stack traces are logged by name only and never sent.
  - Provide the chat model through a Nest provider token (`CHAT_MODEL`) built in
    one place (`chat.module.ts`) as `ChatAnthropic` with model
    `claude-sonnet-5` and the configured API key, so tests inject a fake.
  - Check first whether `@langchain/core`'s testing fakes support `bindTools`
    with scripted tool calls and streamed chunks. If not, write a small fake
    chat model in the spec file that implements only what the service uses.
  - Done when: `npm test` covers the happy path (tool call, then answer, then
    final), a direct answer with no tool call, `not_found` and `unavailable`
    tool results reaching the model, the turn limit, structured-output retry
    success, retry exhaustion, model failure, and `orderIds` grounding. No test
    calls a real provider.

- [x] 3. SSE endpoint
  - Add `apps/orderops-agent/src/chat/chat.controller.ts` (`POST /chat`,
    `JwtAuthGuard`, `ZodValidationPipe` on the body) and `chat.module.ts`, and
    import `ChatModule` and `AuthModule` wiring in `app.module.ts` as needed.
  - The controller reads the bearer token from the already-verified
    `Authorization` header, sets `Content-Type: text/event-stream`,
    `Cache-Control: no-cache`, `Connection: keep-alive`, writes each event as
    `event: <type>\ndata: <json>\n\n`, and ends the response after `final` or
    `error`. On client disconnect it aborts the agent via `AbortController`.
  - 401 (missing/invalid token) and 400 (invalid body) are normal JSON HTTP
    errors returned before any stream starts.
  - Done when: `npm run test:e2e` shows `POST /chat` returning 401 without a
    token, 400 for an invalid body without calling the model, and, with the
    model and `fetch` stubbed, a 200 `text/event-stream` body containing
    `tool_call`, `token`, and `final` events in order, plus one test where the
    model fails and the stream ends with a single `error` event. Unit tests and
    the gateway typecheck pass.

## Files / areas

- New: `apps/orderops-agent/src/chat/chat.module.ts`, `chat.controller.ts`,
  `chat.service.ts`, `chat.prompts.ts` (or the prompt constant inside
  `chat.service.ts`), `chat.schemas.ts`, `orders.client.ts`, `order-tools.ts`,
  and their `*.spec.ts` files.
- Changed: `apps/orderops-agent/src/app.module.ts`,
  `apps/orderops-agent/src/env.ts`, `.env.example`,
  `apps/orderops-agent/test/app.e2e-spec.ts`.
- Existing, reused: `@app/auth` (`AuthModule`, `JwtAuthGuard`,
  `ZodValidationPipe`), `@langchain/anthropic`, `@langchain/core`, `zod`.
  No new dependencies.
- Unchanged: `orders-service` and `customers-service`. The gateway order schema
  mirrors `apps/orders-service/src/orders/order.schemas.ts` rather than
  importing across apps (standards: no cross-app imports, no lib until two apps
  need it).

## Data / contracts

**Request:** `POST /chat`, `Authorization: Bearer <accessToken>`, JSON body
`{ "message": string }`: trimmed, 1 to 2000 characters, no other keys required.

**Pre-stream errors (JSON, existing Nest shape):** 401 from the guard, 400 from
`ZodValidationPipe`.

**SSE stream (200, `text/event-stream`).** Each event is
`event: <type>` plus `data: <single-line JSON>`. Locked shapes:

| Event | `data` | Emitted |
|---|---|---|
| `token` | `{ "text": string }` | Each streamed text delta from the model |
| `tool_call` | `{ "name": "list_orders" \| "get_order", "args": object }` | Once per tool invocation, before it runs |
| `final` | `{ "answer": string, "orderIds": string[] }` | Once, last event on success |
| `error` | `{ "code": "agent_error" \| "invalid_output", "message": string }` | Once, last event on failure |
| `approval_required` | reserved; shape defined by item 4 | Never in this feature |

- Exactly one terminal event (`final` or `error`) ends every stream.
- `token` events are a live preview; `final.answer` is the authoritative reply
  (it comes from the structured-output call and may differ in wording).
- `final.orderIds` contains only ids a tool returned during this request.
- `error.message` is a fixed human-readable string per code; it never contains
  provider text, tokens, or stack traces.
- Later items may add `code` values and event types, but not change these shapes.

**Gateway order schema:** `{ id, customerId, items: [{ sku, name, quantity,
unitPrice }], total, status, createdAt, shippedAt, deliveredAt }`, with money as
`"0.00"` strings, `status` one of `pending | processing | shipped | delivered |
cancelled`, and dates as ISO strings or `null`. This matches the current
`orders-service` responses.

**Trust boundary:** the only identity is the verified JWT. The token is
forwarded unchanged to `orders-service`, which enforces ownership. Tools never
take a customer id, and the model cannot choose whose orders to read.

## Testing

- Unit (`npm test`): chat schemas; orders client outcomes with `fetch` mocked;
  tool output mapping; agent service loop, limits, retry, grounding, and error
  mapping with a fake chat model; SSE line formatting.
- E2E (`npm run test:e2e`): `POST /chat` 401, 400, happy stream, and failure
  stream with the model provider overridden and `fetch` stubbed.
- Typecheck: `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`.
- Lint: `npm run lint`.
- Not claimed by automated tests: real Anthropic behavior. `/check` verifies
  that live with the running services, e.g. login as `ana@example.com`, then
  `curl -N -X POST localhost:3000/chat -H "Authorization: Bearer <token>" -H
  "content-type: application/json" -d '{"message":"where is my latest order?"}'`.

## Notes for the AI

- Construct `ChatAnthropic` only in `chat.module.ts`; item 5 replaces it with the
  provider layer.
- The token stays in the request closure. Never log it, the user message, or
  full prompts.
- Keep the controller thin: it validates, starts the stream, writes events, and
  handles disconnect. The loop, tools, and retry live in the service.
- Do not hold the stream open without a terminal event: every code path,
  including thrown errors after headers are sent, must write `final` or `error`
  and end the response.
- Model id `claude-sonnet-5` is a code constant, not config. Cheap-vs-strong
  routing is item 5.
- If a fake model cannot reproduce streamed tool-call chunks, test the loop on
  complete `AIMessage` turns and cover streaming in the e2e test.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":11387,"specSha256":"66ea5e2161d5a871c418cf8ac8fb10d9858904f4535028ae2013e0d2aa2064f1","branch":"refs/heads/feature/sse-order-chat","head":"64826182943e45df14dddebbf53f8b1dacb8e2b4","baseRef":"refs/heads/master","baseCommit":"23fef3527e60fa8c666249fd30e30f965284ef4a","sourceTree":"2b9ce8d28045dd042714b3b8637c6ab9511f006f","absentOptional":[]} -->

## Independent review

**Status:** passed
**Target commit:** 64826182943e45df14dddebbf53f8b1dacb8e2b4
**Base commit:** 23fef3527e60fa8c666249fd30e30f965284ef4a
**Base ref:** master
**Spec hash:** 66ea5e2161d5a871c418cf8ac8fb10d9858904f4535028ae2013e0d2aa2064f1
**Prepared by:** claude
**Builder model:** claude-opus-5-5
**Requested reviewer:** claude
**Requested model:** claude-opus-5-5
**Requested execution:** automatic
**Requested at:** 2026-09-28T16:00:09Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-opus-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-09-28T16:02:19Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

### Handoff

Review the active spec and the complete `23fef3527e60fa8c666249fd30e30f965284ef4a..64826182943e45df14dddebbf53f8b1dacb8e2b4` delta in a fresh
session or isolated subagent without the builder conversation. Run all Audit lenses from scratch.
Run Check when required above. Do not edit product code, accept findings, or
reuse the existing findings as the review scope.

### Commands

- `npm test`: pass (9 files, 65 tests)
- `npm run test:e2e`: pass (4 files, 19 tests)
- `npm run lint`: pass (oxlint, no diagnostics)
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass

### Evidence

- Preconditions verified: `HEAD` = target, `git merge-base master HEAD` = base, raw SHA-256 of `blueprint/context/current-feature.md` = spec hash, only `blueprint/context/review.md` differed from the target.
- Reviewed all 16 files in the delta: chat controller, module, schemas, service, order tools, orders client, fixture, env, app module, `.env.example`, unit and e2e specs, and the spec.
- Trust boundary holds: tools take no customer id, token comes from the guard-verified header (same split as `JwtAuthGuard`), `orderId` is URL-encoded (path traversal test), orders-service enforces ownership.
- No token, user message, or provider text is logged or streamed: logs record error names and HTTP status only; `error` events use fixed strings.
- Every service path ends in exactly one `final` or `error` (whole generator wrapped in try/catch); turn limit 4 and structured retry 2 are bounded.
- Installed `@langchain/anthropic` 1.5.11 forces tool choice for `withStructuredOutput` and raises `OutputParserException` on schema failure, matching the retry logic; `@langchain/core` 1.2.12 `.text` returns only text blocks, so tool-input deltas never become `token` events.

### Findings

- F-05 [P3] open - tool_call event forwards unchecked model tool names
- F-06 [P3] open - Client-disconnect abort is untested and does not reach tool HTTP calls

### Remaining risk

- Real Anthropic streaming and structured-output behavior is not exercised by any automated test; Check was not required and was not run.
- Spec and e2e files are still not typechecked by the declared tsc command (existing F-02).
- A single model turn may request many tool calls, each a sequential upstream fetch with a 5 s timeout; bounded only by model output (unverified, no runtime evidence).
- No rate limiting on `POST /chat` (explicitly out of scope; cost exposure per authenticated user).
