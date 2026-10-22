# OrderOps Agent - Project Overview

<!-- blueprint:source-hash cea20e9b60b1f872e43ef3ff16348723e2beafacfba1295ee77d64d0eaaa4e2b -->

> A support and operations agent for a fictional e-commerce store (NestJS + LangChain.js + LangGraph.js), built as a guided, deliberately scoped learning and portfolio project for production agentic patterns.

## Problem

Agentic systems that hold up in production need more than a prompt and a model call: they must orchestrate tools against real authenticated services, keep multi-turn state, stay in scope, fall back to deterministic flows on failure, work across LLM providers, and be observable and measurable. This project builds those patterns end to end in an e-commerce support domain where actions have consequences (refunds).

## Users

- **Customer (simulated)** - asks about their orders, shipping/return policies, and requests refunds. Authenticated via JWT; may only see their own orders.
- **Support operator (simulated)** - approves or rejects refunds the agent proposes (human-in-the-loop).
- **Technical reviewer / interviewer (real audience)** - evaluates the agentic engineering through the repo, README metrics, and eval results.

## Features

Build order from `build-plan.md`. Large items are split into lettered sub-features, each one reviewable branch. **Headline: 1. Order lookup chat.**

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

8. **README and system walkthrough** - replace the default NestJS README with documentation written from the real codebase: architecture, prerequisites, step-by-step setup (env, Docker Postgres, migrate and seed, policy ingest), running the three apps, and a guided end-to-end test with copy-paste requests (customer login, order lookup, FAQ, out-of-scope refusal, memory across turns, refund request, operator approve/reject and thread resume), plus tests, traces and cost report, evals (run, compare, regress), troubleshooting, and a project layout map.
9. **Production deploy on AWS** - the three apps and Postgres on one EC2 instance behind HTTPS, Bedrock via the instance IAM role, logs in CloudWatch, and an automated release path.
   - **9a. Containers and production compose** - multi-stage Dockerfiles, production docker-compose (apps, Postgres + pgvector, Caddy with automatic TLS), production env validation, `/health` and `/ready`, migrations and policy ingest as one-off jobs, graceful shutdown that closes open SSE streams.
   - **9b. AWS infrastructure** - EC2 (t4g/t3.small) with an IAM role scoped to `bedrock:InvokeModel*` (no access keys on the server), security group exposing only 80/443, Elastic IP, DNS for `api.arielbailon.dev` (Cloudflare, DNS-only), awslogs to CloudWatch with retention, AWS Budgets alert, nightly `pg_dump` to S3, documented in `docs/deploy.md`.
   - **9c. PR CI pipeline** - PR CI (lint, typecheck, unit tests, e2e against a pgvector service container, Prisma migration check, keyless eval subset with the regression check as a gate, Docker build) extending the existing evals workflow.
   - **9d. CD on main** - OIDC to AWS with no long-lived keys, images to ECR tagged with the commit SHA, deploy over SSM, migrate, smoke test with `/health` and one real chat request, automatic rollback to the previous SHA, with a concurrency guard and a protected production environment.
10. **Observability API and tracing** - read-only endpoints on the existing trace report logic (summary metrics, trace list with filters, trace detail, latest eval results per provider), a `trace` SSE event closing each reply (route, tools, provider, failover, tokens, cost, latency), per-node spans to Langfuse Cloud under the same trace id as `ChatTrace`, and a read-only `viewer` role.
    - **10a. Trace event and failover tracking** - trace id generated by the app up front (stored as `ChatTrace.id`), a persisted failover count per trace, and the `trace` SSE event closing each reply (metadata only, no message text).
    - **10b. Viewer role and read-only observability API** - a read-only `viewer` role (seeded user, token role claim, guard admitting viewer and operator) and read-only endpoints: summary metrics, trace list with filters, trace detail, latest eval results per provider.
    - **10c. Langfuse spans** - per-node spans to Langfuse Cloud through the LangChain callback handler under the same trace id as `ChatTrace`; Langfuse keys in env validation and docs; the app keeps working when Langfuse is unreachable.
11. **Demo console** - Next.js app in `/web` (own package.json, Vercel with Root Directory = `web`, `demo.arielbailon.dev`) that makes agent behavior visible.
    - **11a. Customer chat with agent timeline** - one-click login as seeded demo customers, SSE chat, live per-message side panel (route, tools, provider/model, failover, tokens, cost, latency).
    - **11b. Operator console** - pending refunds, approve/reject that resumes the customer thread, result shown in the customer chat.
    - **11c. Observability dashboard** - p50/p95 latency by route, cost per conversation, tokens by model, cached-token share, error and failover rate, trace explorer linking to Langfuse, eval scorecard by provider.
12. **Public demo hardening** - per-IP rate limiting, daily token/cost budget that switches the agent to a fixed reply, CORS locked to the console origin, nightly reset of demo data (orders, refunds, threads), demo credentials on the login screen.
13. **Showcase** - 2-minute demo video, "Live demo" README section with screenshots and real production metrics (p95, cost per conversation, eval scores), portfolio link replacing the "in progress" placeholder.

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

### ChatTrace / LlmCall (items 6 and 10a)

- `ChatTrace` - one per chat request: `id` (uuid, generated by the app before the request runs), `customerId`, `threadId`, `route` (nullable), `tools` (string[]), `status` (`ok` | `error` | `aborted`), `latencyMs`, `failovers` (int, item 10a), `createdAt`
- `LlmCall` - one per completed model call: `tier`, `provider`, `model`, input/output/cache-read/cache-write tokens, `latencyMs`, `costUsd` (estimate, nullable when unpriced)
- Metadata only: no prompts, messages, tool arguments or results

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
- **Observability** - own traces in Postgres (`ChatTrace`/`LlmCall`) for metrics and the console, plus Langfuse Cloud for per-node span trees
- **Evals/CI** - custom eval runner + GitHub Actions
- **CI/CD** - GitHub Actions with OIDC to AWS, ECR, deploy over SSM
- **Frontend** - Next.js demo console in `/web`, deployed on Vercel
- **Vitest** - unit and e2e tests; **oxlint** - lint
- **SSE** - response streaming

## Monetization

Not applicable - learning/portfolio project.

## UI/UX

API-first. Interaction through curl/HTTP clients and Swagger; optionally one minimal HTML page to watch SSE streaming. A Next.js demo console (customer chat with agent timeline, operator approvals, observability dashboard) is planned post-MVP (items 10-12) so reviewers can see the agent's decisions, cost and latency.

The API contract is the UX:

- Chat endpoint (JWT-authenticated) streaming SSE events: `token`, `tool_call`, `approval_required`, `final`, `error`, and (item 10a) a closing `trace` event
- Predictable error and refusal responses
- > TODO: exact routes (e.g. chat, refund approve/reject for operators) are defined per feature spec

## Deployment

- **Local** - `docker compose up -d` (Postgres + pgvector on 5432) and the three Nest apps
- **Env vars** - `DATABASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (see `.env.example`)
- **Post-MVP AWS (item 9)** - single EC2 instance (t4g/t3.small) running docker compose (three Nest apps, Postgres + pgvector, Caddy with automatic TLS) at `api.arielbailon.dev`; Bedrock through the instance IAM role; logs in CloudWatch; nightly `pg_dump` to S3; AWS Budgets alert from day one; health paths `/health` and `/ready`.
- **Post-MVP console (item 11)** - Next.js on Vercel at `demo.arielbailon.dev`.
- **Why not ECS Fargate + RDS + ALB** - cost for a demo; it is the documented next step to scale.

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
- **Eval results in production** - item 10b serves the latest eval results per provider, but the plan stores them as repo files (`evals/results/*.json`, none committed yet) and the production image ships only build output. Where production reads them from is decided in the 10b spec.
- **Frontend scope conflict** - project-plan section 3 still says "Out of scope on purpose: rich frontend", while section 7 and build-plan items 10-12 add a Next.js demo console. Reword the out-of-scope line in the plan.
