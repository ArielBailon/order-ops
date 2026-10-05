# OrderOps Agent - Project Overview

<!-- blueprint:source-hash c4cdf81d2c83681e6e56899e3eec4e9fcf3b89755985b17af2856cc3fc6b72e4 -->

> A support and operations agent for a fictional e-commerce store (NestJS + LangChain.js + LangGraph.js), built as a guided, deliberately scoped learning and portfolio project for production agentic patterns.

## Problem

Agentic systems that hold up in production need more than a prompt and a model call: they must orchestrate tools against real authenticated services, keep multi-turn state, stay in scope, fall back to deterministic flows on failure, work across LLM providers, and be observable and measurable. This project builds those patterns end to end in an e-commerce support domain where actions have consequences (refunds).

## Users

- **Customer (simulated)** - asks about their orders, shipping/return policies, and requests refunds. Authenticated via JWT; may only see their own orders.
- **Support operator (simulated)** - approves or rejects refunds the agent proposes (human-in-the-loop).
- **Technical reviewer / interviewer (real audience)** - evaluates the agentic engineering through the repo, README metrics, and eval results.

## Features

Build order from `build-plan.md`. Each item is a large, end-to-end feature (data, API, graph, tests) and is intentionally not split. **Headline: 1. Order lookup chat.**

1. **Order lookup chat** - authenticated SSE chat endpoint; the agent answers "where is my order?" by calling `orders-service` through LangChain tool calling, propagating the user's token, with Zod-validated structured output. Also delivers both mock services and their seed data. Split into:
   - **1a. Mock services and login** - `customers-service` and `orders-service` on Postgres via Prisma with seed data; gateway login endpoint that issues JWTs; services validate the token and return only the caller's own data.
   - **1b. SSE order chat** - the authenticated SSE chat endpoint, tool calling against `orders-service` with the user's token, Zod-validated structured output.
2. **Routed agent graph** - LangGraph intent router with a FAQ route (deterministic RAG over policy docs in pgvector), the order route, and an out-of-scope controlled-refusal route.
3. **Conversational memory** - multi-turn threads persisted by the Postgres checkpointer, long-term per-user memory, and context trimming/summarization.
4. **Guarded refunds** - refund route with business rules enforced in code, output validation with bounded retry, operator approval via `interrupt()`, and a deterministic fallback when the agent fails.
   - **4a. Refund rules and request route** - RefundRequest storage in the gateway, code-enforced rules (delivered order, 30-day window, amount <= total, no other open request), refund route with validation, bounded retry and deterministic fallback; creates `pending_approval` requests.
   - **4b. Operator approval** - operator identity, `interrupt()` approval, approve/reject endpoints that resume the thread, `approval_required` SSE event.
5. **Multi-provider models** - Anthropic, OpenAI, and AWS Bedrock behind one interface; cheap model for classification, strong model for reasoning; failover to another provider on error.
6. **Traces and cost** - per-request tracing of agent decisions, tools, tokens, latency (p95), and cost per conversation, plus prompt caching where supported.
7. **Regression evals** - ~40-case dataset (normal, out-of-scope, adversarial); tool-selection, trajectory, answer quality (LLM-as-judge), and guardrail metrics; versioned results; CI workflow; provider comparison table.
   - **7a. Eval harness and dataset** - ~40-case dataset (normal, out-of-scope, adversarial); a runner that drives the real agent graph against a chosen provider with deterministic fake orders data and in-memory stores; route/tool-selection, trajectory and guardrail metrics; versioned results in `evals/results/*.json`.
   - **7b. Answer quality and provider comparison** - LLM-as-judge answer-quality metric with a fixed rubric; provider comparison table generated from the versioned results.
   - **7c. Eval CI** - GitHub Actions workflow: keyless deterministic subset on pull requests, live-provider run on manual dispatch or schedule with repo secrets and a case/cost cap, regression check against the last committed results.

Post-MVP:

8. **AWS deploy** - app running on AWS with real metrics (p95 latency, cost per conversation, eval score) in the README.

Out of scope on purpose: rich frontend, real payments, multi-agent setups, frameworks other than LangChain/LangGraph.

## Architecture

| App | Role |
| --- | --- |
| `apps/orderops-agent` | Gateway + agent: JWT auth, SSE chat endpoint, LangGraph graph, tools, RAG, memory, guardrails, provider layer |
| `apps/orders-service` | Mock orders microservice; returns only the caller's orders based on the propagated token |
| `apps/customers-service` | Mock customers microservice |

Request flow: client -> gateway (JWT) -> graph (router -> route node) -> tools call services over HTTP with the caller's token -> SSE events back to the client.

Graph routes (final shape after items 2 and 4):

- `faq` - deterministic RAG over policy docs (retrieve from pgvector, answer grounded in chunks)
- `order` - tool calling against `orders-service`
- `refund` - agentic + guarded; code-enforced rules, then `interrupt()` for operator approval
- `out_of_scope` - controlled refusal

## Data model

Types are TypeScript-level; exact persistence (Prisma table vs. in-memory mock vs. library-managed) is noted per model.

### Customer (`customers-service`, mock, Postgres via Prisma)

- `id` (string) - primary key; matches the JWT subject
- `name` (string)
- `email` (string)
- `tier` (string enum) - > TODO: tier values and what they affect (not defined in the plans)
- has many `Order`

### Order (`orders-service`, mock, Postgres via Prisma)

- `id` (string) - primary key
- `customerId` (string) - FK -> `Customer.id`; ownership check for every lookup
- `items` (array of `{ sku: string, name: string, quantity: number, unitPrice: number }`) - > TODO: item shape is not specified; this is a proposed minimum
- `total` (decimal)
- `status` (string enum) - > TODO: status values not defined (e.g. pending, shipped, delivered, cancelled)
- `createdAt` (datetime)
- `shippedAt` (datetime, nullable)
- `deliveredAt` (datetime, nullable)
- has many `RefundRequest`

### RefundRequest (item 4)

- `id` (string) - primary key
- `orderId` (string) - FK -> `Order.id`
- `customerId` (string) - FK -> `Customer.id`; must equal the order owner
- `amount` (decimal) - must be <= `Order.total` (rule enforced in code)
- `reason` (string)
- `status` (enum) - `pending_approval` | `approved` | `rejected` | `auto_rejected`
- `decidedBy` (string, nullable) - operator id, or system for `auto_rejected`
- `createdAt` (datetime)

> TODO: which app owns refund data (gateway vs. `orders-service`).

### PolicyDocument / PolicyChunk (item 2)

- Source: markdown files (returns, shipping, warranty) in the repo
- Chunks: text + metadata (`source`, `section`) + embedding vector, stored in pgvector via LangChain's PGVector store (library-managed table, not a Prisma model)

### Agent state (items 1-3)

- Graph state: messages, detected intent, tool results, structured answer
- Thread checkpoints: LangGraph Postgres checkpointer keyed by `thread_id` (library-managed tables)
- Long-term user memory: per-user store keyed by customer id (item 3)

### Eval data (item 7)

- Dataset: JSON cases `{ id, category: normal | out_of_scope | adversarial, input, expected (route, tools, trajectory, answer criteria) }`
- Results: versioned `evals/results/*.json`, one file per run/provider

> Lock the `Order`, `Customer`, and SSE event shapes in item 1; items 2-7 depend on them.

## Tech stack

- **TypeScript + Node.js (ESM)** - runtime
- **NestJS 12 monorepo** (Nest CLI native mode, rspack builder) - gateway + two mock services
- **LangChain.js** - chat model wrappers (`@langchain/anthropic`, `@langchain/openai`, `@langchain/aws`), tools, `withStructuredOutput`, text splitters, PGVector store
- **LangGraph.js** - state graph, conditional edges, Postgres checkpointer, `interrupt()`
- **Zod** - request, tool, and model-output validation
- **PostgreSQL 16 + pgvector** (Docker, `pgvector/pgvector:pg16`) - app data, vectors, checkpoints
- **Prisma 7** - app data access (config `prisma7.config.ts`)
- **LLM providers** - Anthropic (default), OpenAI, AWS Bedrock
- **Observability** - Langfuse or LangSmith (> TODO: decision pending)
- **Evals/CI** - custom eval runner + GitHub Actions
- **Vitest** - unit and e2e tests; **oxlint** - lint
- **SSE** - response streaming

## Monetization

Not applicable - learning/portfolio project.

## UI/UX

API-first. Interaction through curl/HTTP clients and Swagger; optionally one minimal HTML page to watch SSE streaming.

The API contract is the UX:

- Chat endpoint (JWT-authenticated) streaming SSE events: `token`, `tool_call`, `approval_required`, `final`, `error`
- Predictable error and refusal responses
- > TODO: exact routes (e.g. chat, refund approve/reject for operators) are defined per feature spec

## Deployment

- **Local** - `docker compose up -d` (Postgres + pgvector on 5432) and the three Nest apps
- **Env vars** - `DATABASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (see `.env.example`)
- **Post-MVP (item 8)** - AWS: App Runner or ECS + RDS (> TODO: decision pending). Budget alert on the AWS account from day one.

## Open questions

> Gaps found while consolidating the two plans. Resolve them in the plans (or in the relevant feature spec), then re-run /overview.

- **Login credentials** - item 1a adds a gateway login endpoint, which implies customer credentials (a password hash on `Customer`) that project-plan section 4 does not list.
- **Operator identity** - how operators authenticate and approve/reject refunds (role claim in JWT? separate endpoint?). Needed for item 4.
- **Embeddings provider** - pgvector RAG (item 2) needs an embeddings model; Anthropic has none. OpenAI or Bedrock (Titan/Cohere)? Item 5's provider layer does not mention embeddings.
- **Refund business rules** - concrete rules (refund window, max amount, eligible statuses, auto-reject criteria) are not stated. Needed for item 4.
- **Customer tier and order status values** - enums not defined.
- **Long-term memory store** - LangGraph `PostgresStore` or a Prisma table? (item 3)
- **Swagger** - named in UI/UX but not in the tech list (`@nestjs/swagger`).
- **Evals in CI** - LLM-as-judge and provider comparison need real API keys and cost in CI; secrets and budget handling are not specified (item 7).
- **Observability tool** - Langfuse vs LangSmith (item 6).
- **AWS target** - App Runner vs ECS + RDS (item 8).
