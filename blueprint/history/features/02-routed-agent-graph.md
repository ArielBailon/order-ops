# Feature: Routed agent graph

**From build-plan:** feature 2
**Build attempt:** 1
**Branch:** feature/routed-agent-graph
**Status:** verified

## Goal

Replace the single tool-calling loop behind `POST /chat` with a LangGraph state graph: an intent router sends each message to a deterministic FAQ route (RAG over store policy docs in pgvector), the existing order route, or a controlled out-of-scope refusal. The SSE contract and the order behavior from 1b stay intact.

## In scope

- LangGraph `StateGraph` in the gateway: router node, conditional edges, `faq`, `order`, `out_of_scope` nodes.
- Router: cheap structured classification of the message (`faq` | `order` | `out_of_scope`) with Zod output and bounded retry.
- Policy docs (returns, shipping, warranty) as markdown in the repo, chunked, embedded with OpenAI `text-embedding-3-small` (1536 dims) and stored in pgvector through the LangChain PGVector store.
- Idempotent ingestion command that (re)builds the policy index.
- FAQ route: always retrieve top-k chunks, answer grounded only in them; deterministic "no information" reply when retrieval returns nothing usable.
- Order route: the existing 1b tool loop (same tools, same token propagation, same structured answer) moved into a graph node with no behavior change.
- Out-of-scope route: fixed refusal text, no model call.
- `final` event gains a `route` field so clients and later evals can see which route answered.
- Tests with mocked model and embeddings (no real provider calls).

## Out of scope

- Refund route, `approval_required`, operator approval (item 4). Refund requests classify as `out_of_scope` until then; "how do refunds work" questions are `faq`.
- Conversation memory, checkpointer, thread ids (item 3). Each request is a fresh graph run.
- Provider layer, cheap-vs-strong model routing, failover (item 5). The router reuses the single `CHAT_MODEL`.
- Tracing and cost (item 6), eval dataset (item 7).
- Embeddings via Bedrock or a local model; admin or HTTP endpoints for ingestion.

## Build loop

Per `blueprint/config.json`: `stepReview: "feature"`, `checkpointCommits: "disabled"`. Implement the steps in order, keep `npm test`, `npm run lint`, and the typecheck green after each, and present one review packet after the last step. `/complete` creates the single feature commit.

## Build steps

- [x] 1. Policy docs, embeddings, and ingestion
  - Add `@langchain/openai` and the LangChain PGVector store package (confirm the current package name and its `pg` compatibility before installing; install with `npx -y npm@11 install`). Add `@langchain/textsplitters` only if it is not already transitive.
  - Write three fictional policy markdown files under `apps/orderops-agent/policies/` (`returns.md`, `shipping.md`, `warranty.md`) with concrete, distinct facts (windows, costs, conditions) so answers are checkable.
  - Add `OPENAI_API_KEY` as required in `apps/orderops-agent/src/env.ts`; keep it in `.env.example`.
  - New `apps/orderops-agent/src/faq/` module: embeddings provider (single construction point, injectable token), policy loader + splitter (chunk metadata `source`, `section`), vector store provider, and an ingestion entry point run as `npm run ingest:policies` (add the script; use `tsx`, already a devDependency). Ingestion replaces the whole policy collection so reruns are idempotent.
  - Done when: `docker compose up -d` + `npm run ingest:policies` reports a chunk count and a rerun reports the same count with no duplicates (checked with a SQL count); a unit test covers loader/splitter output (metadata, non-empty chunks) with no network.

- [x] 2. FAQ retrieval and grounded answer
  - `FaqService`: retrieve top-k (constant, start at 4) from the vector store, then call the model with a prompt that answers only from the supplied chunks; structured output reuses `finalAnswerSchema` with `orderIds: []`, bounded retry like 1b.
  - If retrieval returns no chunks, return a fixed "I don't have that in our store policies" answer without calling the model. Embedding or store failure surfaces as the existing `agent_error` fallback, never a raw error.
  - Prompt constant lives next to the node, per standards.
  - Done when: unit tests with a fake vector store and fake model cover grounded answer, empty retrieval (no model call), invalid structured output retry then `invalid_output`, and store failure to `agent_error`.

- [x] 3. Router and graph with order and refusal routes
  - `apps/orderops-agent/src/agent/`: graph state (message, token, signal, route, final answer), router node (structured `{ intent }` schema, max 2 attempts, failure to `invalid_output`), conditional edges, `out_of_scope` node (fixed refusal text, `orderIds: []`), `order` node wrapping the existing tool loop and structured answer unchanged. The router sees only the user message, never tool output.
  - Nodes emit `token` and `tool_call` events through the graph's custom stream writer; `ChatService.reply` becomes a thin driver over `graph.stream` that still always ends with exactly one `final` or `error` event and honors the abort signal. Confirm the `streamMode: "custom"` writer API against the installed `@langchain/langgraph` before building on it.
  - Extend `finalAnswerSchema`/`ChatEvent` so `final` carries `route: 'faq' | 'order' | 'out_of_scope'`; update `chat.schemas.ts` and its spec. Existing event types and error codes are unchanged.
  - Move order-specific code only as needed; keep `order-tools.ts` and `orders.client.ts` untouched.
  - Done when: unit tests cover router retry/failure, each conditional edge routes to the right node, order route behaves as before (existing `chat.service.spec.ts` cases still pass, adapted to the driver), refusal makes no model call beyond the router, and `npm test` is green.

- [x] 4. Wire FAQ node and end-to-end checks
  - Register the FAQ module in `ChatModule`; connect `FaqService` as the `faq` node.
  - Extend `apps/orderops-agent/test/chat.e2e-spec.ts` with mocked model and embeddings: FAQ message returns a `final` with `route: 'faq'`; order message keeps its 1b result with `route: 'order'`; off-topic message returns the refusal with `route: 'out_of_scope'`; unauthenticated request is still rejected; client disconnect still stops the run.
  - Update `AGENTS.md` Commands with the ingestion command and the `OPENAI_API_KEY` requirement.
  - Done when: `npm run test:e2e`, `npm test`, `npm run lint`, `npm run typecheck:spec`, and `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit` pass. Live smoke (needs real keys, run by the user during `/check`): after ingesting, `POST :3000/chat` with a returns question streams a `final` with `route: "faq"` grounded in the policy text; an order question and an off-topic question route as above.

- [x] 5. Repair: gateway startup (found by /check)
  - Add `DATABASE_URL` as required in the gateway env schema (`apps/orderops-agent/src/env.ts`) so `ConfigService` exposes it to the policy store provider; set it in the two gateway e2e tests.
  - Add `env.spec.ts` covering that `validateEnv` keeps `DATABASE_URL` and rejects a config without it.
  - Done when: the gateway boots via `npm run start:all`, and `npm test`, `npm run test:e2e`, lint, and both typechecks pass.

## Files / areas

- `apps/orderops-agent/src/agent/` (new: graph, state, router, refusal)
- `apps/orderops-agent/src/faq/` (new: embeddings, splitter/loader, vector store, ingestion, `FaqService`)
- `apps/orderops-agent/policies/*.md` (new)
- `apps/orderops-agent/src/chat/chat.service.ts`, `chat.schemas.ts`, `chat.module.ts` (driver, `route` field, wiring)
- `apps/orderops-agent/src/env.ts`, `.env.example`, `package.json`, `AGENTS.md`
- `apps/orderops-agent/test/chat.e2e-spec.ts` and new `*.spec.ts` beside each unit

## Data / contracts

- SSE: `token`, `tool_call`, `final`, `error` as in 1b. `final.data` is `{ answer, orderIds, route }`. `approval_required` stays reserved.
- Router output: `{ intent: 'faq' | 'order' | 'out_of_scope' }`, validated with Zod.
- Vector data: PGVector store in the shared Postgres, library-managed table (not a Prisma model, no Prisma migration), dimension 1536, one collection for policies, rows carry `source` and `section` metadata.
- Embedding model id and top-k are code constants in one place; changing the model requires re-ingesting.
- Order route authorization is unchanged: tools take no customer id, ownership is enforced by `orders-service` from the propagated token. The FAQ route handles no per-user data.

## Testing

- Vitest unit tests (no real providers): splitter/loader, `FaqService`, router, graph edges, refusal route, schemas.
- E2E (supertest, mocked `CHAT_MODEL` and embeddings) for all three routes, auth, and disconnect.
- Not unit-tested: real model routing quality and answer grounding; those are measured by the eval suite (item 7). The live smoke in step 4 is manual evidence only.
- No Verify command is declared; run the individual commands listed in step 4.

## Notes for the AI

- Do not call real LLM or embedding APIs in tests; use `vi.mock` or injected fakes.
- Prompts are exported constants next to their node. No em dashes in generated content, including the policy docs.
- Keep 1b behavior byte-for-byte where possible: same tools, same `MAX_MODEL_TURNS`, same error codes and messages.
- Do not log tokens or full prompts containing user text.
- Policy numbers are fictional; keep them consistent across the three docs.
- Reuse `CHAT_MODEL` for the router; do not introduce a second model or provider abstraction (item 5).

## Open questions

- Similarity-score cutoff for "no usable chunks": start with "no results returned" only (no threshold) and revisit with evals in item 7. Tell me if you want a threshold now.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":9745,"specSha256":"f2f67fc6fba77f423e638552e4e7888959fa7d7c3db0add38397e857b9bec705","branch":"refs/heads/feature/routed-agent-graph","head":"79ca6a80f0e4b215a0062219a7a57f6a88cecbca","baseRef":"refs/heads/master","baseCommit":"79ca6a80f0e4b215a0062219a7a57f6a88cecbca","sourceTree":"c8197c2fe4707630bc82fa825148a2e73065c8ca","absentOptional":[]} -->
