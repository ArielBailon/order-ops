# Feature: Traces and cost

**From build-plan:** feature 6
**Build attempt:** 1
**Branch:** feature/traces-and-cost
**Status:** verified

## Goal

Make every chat request observable and measurable without an external service:
record per-request traces (route, tools used, each model call with provider, model,
tokens, latency, cost) in Postgres, report p95 latency and cost per conversation with
a script, and add prompt caching on the providers that support it (Anthropic and
Bedrock) with cached-token counts visible in the traces.

## In scope

- Two new Prisma models in the gateway database:
  - `ChatTrace` - one row per chat request: route, tool names used, status
    (`ok` | `error` | `aborted`), total latency, customer and thread ids.
  - `LlmCall` - one row per completed model call under a trace: tier, provider,
    model id, input/output/cached-read/cache-write tokens, latency, cost in USD.
- A hand-written migration (project rule: `migrate dev` wants to reset because of
  library-managed tables; use `npx prisma migrate deploy`).
- Pricing table (USD per million tokens: input, output, cache read, cache write) per
  model id in `models/`, and a pure cost function; unknown model id -> cost null
  (never a guess), tokens still recorded.
- A recorder: a LangChain callback handler attached per request that collects
  `LlmCall` data (from `usage_metadata`, response model name, timing), plus trace
  data taken from the existing SSE events (`route` from `final`, tool names from
  `tool_call`). Persisted once when the request ends, including errors and client
  aborts. Persistence is best-effort: a store failure is logged and never changes
  the chat response.
- Prompt caching, applied inside the failover wrapper per candidate provider:
  Anthropic gets `cache_control` on the marked system message, Bedrock gets its
  cache point, OpenAI is left alone (it caches automatically and still reports
  cached tokens). Prompts that are marked cacheable: the long, stable system
  prompts (router, FAQ, order, refund, facts, summary).
- `npm run report:traces` script printing, for a time window: request count, p50/p95
  request latency overall and per route, total and per-conversation cost
  (avg and max), per-provider/model token and cost totals, cached-token share.
- Unit tests; docs (AGENTS.md Commands, `.env.example` only if a var is added).

## Out of scope

- Langfuse, LangSmith, OpenTelemetry or any external tracing service (decision:
  built-in Postgres traces; export can be a later change).
- Storing prompt text, customer messages, tool arguments or tool results, or model
  output in traces (metadata only, so no customer content is persisted here).
- A trace-viewing HTTP endpoint, dashboard or UI; retention/cleanup jobs.
- Evals and provider comparison (feature 7); AWS metrics in the README (item 8).
- Changing prompts' wording, graph shape, SSE contract or failover behavior.
- Recording failed provider attempts that were failed over (already logged by the
  failover wrapper); only completed model calls get an `LlmCall` row.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement
all steps, then review once as a single packet. No per-step pauses or checkpoint
commits; `/complete` creates the final commit.

## Build steps

- [x] 1. Schema and store. Add `ChatTrace` and `LlmCall` to `prisma/schema.prisma`
  (ids as the repo's existing id style; `LlmCall.traceId` FK with index; indexes on
  `ChatTrace.createdAt` and `threadId`; token columns Int, `costUsd` Decimal(12,6)
  nullable, `latencyMs` Int). Hand-write the migration under
  `prisma/migrations/`, run `npx prisma generate`. Add `trace/trace.store.ts` with
  an interface and a Prisma implementation that writes a trace and its calls in one
  transaction, and a `TraceModule`.
  **Done when:** `npx prisma migrate deploy` applies cleanly on the dev database and
  `prisma migrate diff` proposes no change for the new tables; a store spec (faked
  Prisma, as `user-memory.store.spec.ts` does) proves one transaction writes the
  trace and all calls; `npm test` and `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit` pass.
- [x] 2. Pricing and usage. Add `models/pricing.ts` (price table keyed by the model
  ids in `MODEL_IDS`, and `costUsd(modelId, usage)`), and a `usageOf(message)` helper
  that reads input/output/cached-read/cache-write tokens from `usage_metadata`
  (including `input_token_details`).
  **Done when:** specs prove: known model computes cost from all four token kinds,
  unknown model returns null, missing usage returns zeros, every `MODEL_IDS` entry
  has a price; `npm test` passes.
- [x] 3. Prompt caching. Add a `cacheableSystem(text)` helper in `models/` that marks
  a `SystemMessage`, and make `createFailoverModel` rewrite marked messages per
  candidate before calling it (Anthropic: content block with `cache_control`;
  Bedrock: the cache point form its installed converter accepts; OpenAI: unchanged,
  marker stripped). Use it for the stable system prompts in router, FAQ, order,
  refund, facts and summary nodes. Confirm the exact block shapes against the
  installed `@langchain/anthropic` and `@langchain/aws` converters rather than
  assuming.
  **Done when:** specs prove each provider receives the right message shape and that
  an unmarked message is passed through untouched, and the existing graph specs still
  pass; `npm test` and `npm run test:e2e` pass.
- [x] 4. Recorder and wiring. Add `trace/trace-recorder.ts`: a callback handler that
  collects one `LlmCall` per `handleLLMEnd` (provider derived from the model id via
  `MODEL_IDS`, tier from the same lookup, latency from start/end, cost via step 2),
  and a per-request collector that `ChatService.reply` creates, passes as
  `callbacks` in the graph config, feeds route and tool names from the events it
  already yields, and flushes in a `finally` with status `ok`, `error` (an `error`
  event) or `aborted` (signal aborted). Flush failure is caught and logged by error
  name only.
  **Done when:** `chat.service.spec.ts` additions prove a request writes one trace with
  the route, tool names, and one call per model invocation with tokens and cost from
  scripted `usage_metadata`; an error turn and an aborted turn are recorded with the
  right status; a throwing store does not alter the emitted events; no message
  text appears in anything passed to the store; `npm test`, `npm run test:e2e`,
  `npm run typecheck:spec` and `npm run lint` pass.
- [x] 5. Report script. Add `apps/orderops-agent/src/trace/report-traces.ts` and
  `npm run report:traces` (same `tsx --env-file=.env` style as `ingest:policies`),
  with optional `--since <ISO date>` (default last 7 days). Percentiles via SQL
  `percentile_cont`; cost per conversation grouped by thread id.
  **Done when:** a spec on the report's formatting/aggregation helpers passes with
  fixture rows; running it against the dev database with traces present (after a
  manual chat) prints the sections listed in scope, or the run is reported as not
  executed.
- [x] 6. Docs. Add the report command and the trace tables to AGENTS.md Commands;
  note in coding-standards that traces store metadata only.
  **Done when:** both describe the shipped behavior.

## Files / areas

- New: `apps/orderops-agent/src/trace/` (store, module, recorder, report script,
  specs); `apps/orderops-agent/src/models/pricing.ts` (+spec), caching helper in
  `models/`; one migration under `prisma/migrations/`.
- Changed: `prisma/schema.prisma`, `models/failover.ts` (+spec), prompt constants'
  call sites (`agent/router.ts`, `faq/faq.service.ts`, `agent/order-route.ts`,
  `agent/refund-route.ts`, `memory/facts.ts`, `agent/compaction.ts`),
  `chat/chat.service.ts` (+spec), `chat/chat.module.ts`, `package.json`,
  `AGENTS.md`, `blueprint/context/coding-standards.md`.

## Data / contracts

- No change to HTTP routes or SSE events.
- `ChatTrace`: id, customerId, threadId (the client thread uuid, not the
  `customerId:` prefixed checkpoint key), route (nullable when it failed before
  routing), tools (text array of tool names), status, latencyMs, createdAt.
- `LlmCall`: id, traceId, tier (`cheap`|`strong`), provider, model, inputTokens,
  outputTokens, cacheReadTokens, cacheWriteTokens, latencyMs, costUsd (nullable),
  createdAt. `inputTokens` follows the provider's own definition as surfaced by
  `usage_metadata` (cached tokens are counted separately in the cache columns; cost
  must not double count them: spec the formula in Step 2 and test it).
- Cost is USD from the in-repo price table; it is an estimate, not a bill.
- Privacy: metadata only; ids already exist in the database (customer, thread).

## Testing

- Vitest unit specs with faked Prisma and fake models, no network or keys.
- Migration, report and real token/caching behavior need the dev database and live
  keys; the report and a real cached-token count are manual evidence and are only
  claimed if actually run. Caching below a provider's minimum prompt size is silently
  not applied by the provider; real cache hits cannot be proven with fakes.

## Notes for the AI

- Follow `user-memory.store.ts` / `refund.store.ts` for Prisma store shape and the
  `libs/prisma` import (`@app/prisma`).
- LangGraph propagates callbacks passed in the run config into node model calls;
  confirm that callbacks from `graph.stream({...}, { callbacks })` reach the
  `bindTools(...).stream` and `withStructuredOutput(...).invoke` calls made through
  the failover wrapper (it forwards `options`, but `order-route.ts` passes only
  `{ signal }`; check whether ambient context is enough and fix at the call site
  only if needed).
- Keep prompts next to their nodes; only wrap them with `cacheableSystem`.
- Use `npx -y npm@11 install` if a dependency is needed (none is expected).
- Do not run `prettier --write` over the whole app (it rewrites CRLF files); format
  only files you touch.

## Open questions

- **Price table values.** Proposed USD per million tokens (list prices, to confirm
  before relying on cost figures): Anthropic Haiku 4.5 1 in / 5 out, Sonnet
  3 in / 15 out; OpenAI gpt-4o-mini 0.15 / 0.60, gpt-4o 2.50 / 10; Bedrock Claude
  models at the same rates as Anthropic; cache read 0.1x input and cache write
  1.25x input for Anthropic/Bedrock, cache read 0.5x for OpenAI. Confirm or correct
  these numbers.
- **Retention.** No cleanup of trace rows is planned; confirm that is acceptable.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":10492,"specSha256":"af09df0dd05a2842b7a5219867a74feaaa80e3a967fe4c8ccf0ea2adf295c417","branch":"refs/heads/feature/traces-and-cost","head":"a2e2766b412917b8def954c14ba78e77dff5f135","baseRef":"refs/heads/master","baseCommit":"0f8895cbaba658bcc00df7c06cb0ea80feb2cf16","sourceTree":"52f4365ed207f26e28973438d050971f05e7b376","absentOptional":[]} -->

## Findings

### 6/F-09 [P3] accepted - Stored refund reason depends on the model and is untrusted text for operators

**File:** apps/orderops-agent/src/agent/refund-route.ts:100
**Found:** 2026-10-01 by /audit independent (scope: current; lens: security)
**Why it matters:** The 'reason required' guard and the stored reason both depend on the model. It can invent a reason, and injected text can end up in the stored reason that operators will read in feature 4b. Amount and order cannot escape the code-enforced rules or the owner check.
**Suggested fix:** Accept for 4a. In 4b, show the reason to operators as quoted data.
**Resolution:** 2026-10-02 independent review of 5f9ba3b: `GET /refunds/pending` returns `reason` only as a JSON string value and AGENTS.md labels it untrusted customer text, which applies the 4b suggestion. The model-dependent reason itself remains; status left for the builder/user to set. Re-checked 2026-10-02 against f930c70: unchanged (refund.store.ts:54-55 and :176 return it as plain JSON data); still open pending a user decision to accept or close. Re-checked 2026-10-02 against f76b920: unchanged; still open.

**Accepted:** 2026-10-03 by the user in chat. Reason: P3; operators see the reason as untrusted quoted JSON data, and amount and order stay bound by code-enforced rules and the owner check, so the model-written reason text is an accepted residual risk.

## Independent review

**Status:** passed
**Target commit:** a2e2766b412917b8def954c14ba78e77dff5f135
**Base commit:** 0f8895cbaba658bcc00df7c06cb0ea80feb2cf16
**Base ref:** refs/heads/master
**Spec hash:** af09df0dd05a2842b7a5219867a74feaaa80e3a967fe4c8ccf0ea2adf295c417
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-03T15:58:12Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-03T15:59:31Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

### Commands

- `git rev-parse HEAD`, `git merge-base refs/heads/master HEAD`, `sha256sum blueprint/context/current-feature.md`, `git status --porcelain`: pass (target, base and spec hash match; only review.md and findings.md differ)
- `npm test`: pass (26 files, 244 tests)
- `npm run test:e2e`: pass (5 files, 40 tests)
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npm run typecheck:spec`: pass
- `npm run lint`: pass

### Evidence

- Reviewed the full 0f8895c..a2e2766 delta: schema and migration, trace store and module, recorder, report script and formatter, pricing, prompt-cache and failover changes, call-site changes, chat service and module wiring, and the new specs.
- Installed @langchain/aws and @langchain/anthropic converters confirm the cache point block shape and that input_tokens already includes cache read and write tokens, so the cost formula does not double count.
- chat.service.spec drives callbacks through the ambient LangChain context, which confirms they reach model calls made via the failover wrapper.
- Traces carry ids, route, tool names, tokens, latency and cost only; no message text is stored, and the report SQL is parameterized.
- Controller breaks out of the stream on abort, so the generator's finally runs and records the trace.

### Findings

- F-10 [P3] open: report groups conversations by threadId only.
- F-11 [P3] open: trace write is awaited on the response path with no bound.
- F-09 was not re-reviewed and is left untouched.

### Remaining risk

- Real provider behavior was not exercised: live token usage in streams, actual cache hits and Bedrock cache point acceptance, and the report against a database with data. Fakes cannot prove these.
- Migration application and prisma migrate diff were not run by this review.
- Price table values are unconfirmed list prices (open question in the spec); costs are estimates.
- No trace retention or cleanup, per the spec.
