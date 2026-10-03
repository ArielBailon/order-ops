# Feature: Multi-provider models

**From build-plan:** feature 5
**Build attempt:** 1
**Branch:** feature/multi-provider-models
**Status:** verified

## Goal

Replace the single hard-coded `ChatAnthropic` with a provider layer: Anthropic,
OpenAI and AWS Bedrock chat models behind one interface, a cheap model for
classification-style work and a strong model for reasoning, and automatic failover
to the next provider when a call errors.

## In scope

- One provider module in the gateway that builds the chat models and is the only
  place that imports `@langchain/anthropic`, `@langchain/openai`, `@langchain/aws`
  for chat (coding-standards: "Model access goes through the project's provider
  layer once it exists").
- Two tiers, `cheap` and `strong`, each resolving to a `BaseChatModel`-compatible
  object so graph nodes keep calling `bindTools`, `stream`, `withStructuredOutput`
  and `invoke` unchanged.
  - `cheap`: intent router, long-term fact extraction, history summarization.
  - `strong`: FAQ answer, order route, refund route (tool loops and extraction).
- Failover: each tier is an ordered list of providers (fixed order Anthropic ->
  OpenAI -> Bedrock, skipping providers without credentials). An error from one
  provider moves the call to the next; when all fail the last error propagates, so
  the existing `agent_error` / deterministic-fallback paths behave as today.
- Bedrock enabled only when `AWS_REGION` is set (credentials from the standard AWS
  chain or the existing `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
- A `warn` log line when a call fails over (provider name and error name only).
- Unit tests with fake models; docs updates (`.env.example`, AGENTS.md Commands,
  coding-standards line).

## Out of scope

- Embeddings: policy ingestion and FAQ retrieval stay on OpenAI embeddings.
- Tracing, token/cost accounting, prompt caching (feature 6) and provider
  comparison evals (feature 7).
- Runtime provider switching by request, per-user routing, a provider config file
  or env-driven provider ordering, circuit breakers, retries with backoff.
- Changing prompts, graph shape, or the SSE contract.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement
all steps, then review once as a single packet. No per-step approval pauses and no
step checkpoint commits; `/complete` creates the final commit.

## Build steps

- [x] 1. Provider catalog and env. Install `@langchain/aws` (`npx -y npm@11 install`).
  Add `apps/orderops-agent/src/models/providers.ts`: a typed table of
  `{ provider, tier } -> model id`, and `createChatModel(provider, tier, env)`
  returning the LangChain chat model. Extend `env.ts` with optional `AWS_REGION`
  (and optional AWS key pair); `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` stay required.
  **Done when:** a spec shows each (provider, tier) constructs the expected class and
  model id without network access, Bedrock is omitted when `AWS_REGION` is unset,
  and `env.spec.ts` covers the new optional fields; `npm test` passes.
- [x] 2. Failover wrapper. Add `models/failover.ts`: a chat model over an ordered
  list of candidates whose `invoke`/`stream`, `bindTools(...)` and
  `withStructuredOutput(...)` results each fail over to the next candidate on error.
  Abort errors (client disconnect via `signal`) never fail over. Streaming fails
  over only before any chunk has been yielded, so a partial answer is never
  spliced across providers. Log failovers with provider name and error name.
  **Done when:** a spec with fake candidates proves: first success is used and
  later ones are untouched; error moves to the next; all-fail rethrows the last
  error; abort does not fail over; a mid-stream error after the first chunk
  propagates; tools and structured output also fail over; `npm test` passes.
- [x] 3. Wire the tiers. Replace `ChatModelModule`/`CHAT_MODEL` with a provider
  module exporting `CHEAP_MODEL` and `STRONG_MODEL` tokens built from env. Change
  `AgentDeps` from one `model` to `{ cheap, strong }` and pass `cheap` to `router`,
  `remember` and `compact`, `strong` to `faq` (via `FaqService`), `order` and
  `refund`. Update `ChatService`, `FaqService`, specs and e2e fixtures
  (`test/*.e2e-spec.ts`, `chat.service.spec.ts`, `refund-route.spec.ts`,
  `router.spec.ts`) that construct or override the model.
  **Done when:** a graph/service spec proves the router, memory and summary calls hit
  the cheap fake and order/refund/FAQ calls hit the strong fake; existing behavior
  specs pass unchanged in meaning; `npm test`, `npm run test:e2e`,
  `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`,
  `npm run typecheck:spec` and `npm run lint` pass.
- [x] 4. Docs. Update `.env.example` (Bedrock vars optional, model tiers described),
  the AGENTS.md Commands env note, and the coding-standards "provider layer" line
  to point at `apps/orderops-agent/src/models/`.
  **Done when:** the three files describe the shipped behavior and `npm run format`
  leaves no diff.

## Files / areas

- New: `apps/orderops-agent/src/models/` (`providers.ts`, `failover.ts`, provider
  Nest module, specs).
- Changed: `src/env.ts` (+spec), `src/chat/chat-model.module.ts` and
  `chat-model.token.ts` (replaced), `chat.service.ts`, `chat.module.ts`,
  `faq/faq.module.ts`, `faq/faq.service.ts`, `agent/agent.graph.ts`, affected
  specs and `test/*.e2e-spec.ts`, `package.json` / lockfile,
  `.env.example`, `AGENTS.md`, `blueprint/context/coding-standards.md`.

## Data / contracts

- No DB, API or SSE changes. `error` events keep codes `agent_error` and
  `invalid_output`; failover is invisible to clients.
- Tier -> model ids (proposed, constants in `providers.ts`; see Open questions):
  Anthropic cheap `claude-haiku-4-5-20251001`, strong `claude-sonnet-5` (the id used
  today); OpenAI and Bedrock ids to be confirmed.
- Secrets: API keys stay env-only and are never logged; failover logs carry only
  provider and error name.

## Testing

- Vitest unit specs with fake chat models (no network, no keys): catalog, failover
  semantics, tier assignment in the graph.
- E2E specs keep using mocked models. A live check against real providers is not
  run by Verify; do it by hand: start the gateway, `POST /chat` once, then with the
  Anthropic key made invalid confirm the reply still arrives via OpenAI and a
  failover warning is logged. Report it as manual evidence only if actually run.
- Streaming, tool-calling and structured-output parity across the three real
  providers is not provable with fakes; flag it in the review handoff.

## Notes for the AI

- Prefer LangChain's `RunnableWithFallbacks` (`.withFallbacks`) for the failover
  behavior if it satisfies Step 2's contract (notably: abort not failing over,
  tool binding and structured output preserved, no mid-stream splice); otherwise
  write the thin wrapper. Confirm against the installed `@langchain/core` source
  rather than assuming.
- Callers only need `bindTools`, `stream`, `withStructuredOutput`, `invoke`
  (see `order-route.ts`, `structured-output.ts`); do not add other surface.
- Keep prompts next to their nodes; do not touch them.
- Use `npx -y npm@11 install` (npm 10.9.3 crashes on this project).
- No Verify command is declared in AGENTS.md; none was run while speccing.

## Open questions

- **Model ids for OpenAI and Bedrock tiers.** Which exact models do you want
  (cheap and strong)? Bedrock ids also depend on region and account access
  (inference profile ids). Until answered, Step 1 uses the Anthropic ids above and
  placeholders for the others that you confirm at review.
- **Anthropic stays required at startup?** Proposed: yes (unchanged). If you want
  to run on OpenAI only, say so and Step 1 makes it optional with "at least one
  chat provider" validation.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":7809,"specSha256":"cb8df36eff0fe6779000dc56ff682597d4fd57c5ceaddae3334b42d36f901bd4","branch":"refs/heads/feature/multi-provider-models","head":"7d8070ad778c3c50490b532e9cf6d786a962e2c5","baseRef":"refs/heads/master","baseCommit":"7d8070ad778c3c50490b532e9cf6d786a962e2c5","sourceTree":"220bca40fff063a37c83354d20252ea85bfeb347","absentOptional":[]} -->

## Findings

### 5/F-11 [P3] invalid - Partial unique index exists only in hand-written SQL

**File:** prisma/migrations/20261001120000_refund_requests/migration.sql:33
**Found:** 2026-10-01 by /audit independent (scope: current; lens: quality)
**Why it matters:** The partial unique index is not modeled in schema.prisma, so a later prisma migrate diff may report drift or propose dropping it. Not confirmed without running a database. The migration SQL itself matches the schema.
**Suggested fix:** Document it next to the model (done in a schema comment) and re-check drift output when the next migration is generated.
**Resolution:** 2026-10-02 independent review of 5f9ba3b: the committed `20261002120000_operator_role/migration.sql` contains no `DROP INDEX`; raw `prisma migrate diff` output was not re-run (needs a database), so drift remains unverified. Re-checked 2026-10-02 against f930c70: migration unchanged (CREATE TYPE plus two ADD COLUMN, no DROP INDEX); still unverified for the same reason. Re-checked 2026-10-02 against f76b920: migration unchanged; still unverified (no database run in review). Invalid, re-examined 2026-10-02 against the live dev database (migrate status: schema up to date). `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` proposes no index change; its only output is DROP TABLE for the library-managed checkpoint_* and policy_chunks tables, which are expected. pg_indexes shows RefundRequest_orderId_pending_key as a UNIQUE btree on orderId WHERE status = pending_approval, so the partial index exists and is not dropped.

### 5/F-20 [P3] invalid - Per-customer advisory lock in the memory store was never run against Postgres

**File:** apps/orderops-agent/src/memory/user-memory.store.ts:26
**Found:** 2026-10-02 by /audit (scope: current; lens: quality, performance, tests)
**Why it matters:** The store spec fakes the Prisma client, so it proves call order but not that `$executeRaw` accepts the `SELECT pg_advisory_xact_lock(...)` statement through the PrismaPg adapter, nor that concurrent `add` calls really serialize. If the statement were rejected, every fact write would fail and only log "memory write failed", so long-term memory would silently stop updating.
**Suggested fix:** Check once against the dev database: send two simultaneous chat turns for one customer that each state a different preference and confirm both facts land in `UserMemory.facts`. No code change expected.
**Resolution:** Invalid, re-examined 2026-10-02 against the live dev database: a throwaway test with two PrismaService connections ran 10 rounds of two concurrent PrismaUserMemoryStore.add calls for ana@example.com (20 distinct facts, equal to the cap). All 20 were stored, so the advisory lock statement runs under the PrismaPg adapter and no fact was lost. No negative control without the lock was run. The test file was deleted and the customer's original facts restored.
