# OrderOps Agent — Project Plan

## 1. Problem
Building agentic AI systems that hold up in production requires more than a prompt and a model call: agents must orchestrate tools against real authenticated services, keep multi-turn state, stay inside their scope, fall back to deterministic flows when they fail, work across LLM providers, and be observable and measurable. This project is a guided, deliberately scoped build to learn and demonstrate those patterns end-to-end, using a fictional e-commerce support/operations domain where actions have real consequences (e.g., refunds).

## 2. Users
- Primary (simulated): customers of a fictional e-commerce store asking about orders, shipping/return policies, and requesting refunds.
- Secondary (simulated): a support operator who approves or rejects refunds the agent proposes (human-in-the-loop).
- Real audience: technical reviewers and interviewers evaluating agentic AI engineering skills (portfolio project).

## 3. Features (MVP)
- Chat endpoint that streams responses over SSE, authenticated with JWT.
- Order status lookup via tool calling against `orders-service`, propagating the user's identity/token (the agent can only see the caller's own orders).
- LangGraph state graph with an intent router: FAQ route (deterministic RAG over store policies with pgvector), order route (tool calling), refund route (agentic + guarded), out-of-scope route (controlled refusal).
- Multi-turn memory: per-thread short-term memory via a Postgres checkpointer, long-term per-user memory, and context trimming/summarization.
- Guardrails: scope check on input, output validation with Zod schemas and bounded retry, business rules enforced in code (not in the prompt), human approval via LangGraph `interrupt()` for refunds, deterministic fallback when the agent fails.
- Provider layer: Anthropic, OpenAI and AWS Bedrock interchangeable behind one interface; cheap model for classification, strong model for reasoning; failover to another provider on error.
- Observability: per-request traces (agent decisions, tools used, tokens, latency, cost per conversation), prompt caching where supported.
- Evals: ~40-case dataset (normal, out-of-scope, adversarial), metrics for tool selection, trajectory, final-answer quality (LLM-as-judge) and guardrail behavior; results versioned in the repo; run in CI; provider comparison table.

Out of scope on purpose: rich frontend, real payments, multi-agent setups, frameworks other than LangChain/LangGraph.

## 4. Data
- Customer (mock, `customers-service`): id, name, email, tier.
- Order (mock, `orders-service`): id, customerId, items, total, status, createdAt, shippedAt, deliveredAt.
- Refund request: id, orderId, customerId, amount, reason, status (pending_approval / approved / rejected / auto_rejected), decidedBy, createdAt.
- Policy documents: store policies/FAQ (returns, shipping, warranty) as markdown, chunked and embedded into pgvector.
- Agent state: LangGraph checkpoints per thread (Postgres), long-term user memory store.
- Eval data: eval dataset (JSON) and versioned eval results (`evals/results/*.json`).

## 5. Tech
- Language/runtime: TypeScript, Node.js.
- Framework: NestJS monorepo (gateway + agent app, `orders-service`, `customers-service`).
- AI: LangChain.js (chat model wrappers `@langchain/anthropic`, `@langchain/openai`, `@langchain/aws`; tools; `withStructuredOutput`; text splitters; PGVector store) and LangGraph.js (state graph, conditional edges, Postgres checkpointer, `interrupt()`).
- Validation: Zod.
- Database: PostgreSQL + pgvector (Docker), Prisma for app data.
- LLM providers: Anthropic (default), OpenAI, AWS Bedrock.
- Observability: Langfuse or LangSmith (decision pending).
- Evals/CI: custom eval runner + GitHub Actions.
- Streaming: SSE.

## 6. Monetize
Not applicable — learning/portfolio project.

## 7. UI/UX
API-first. Interaction via curl/HTTP client and Swagger; optionally a single minimal HTML page to watch SSE streaming. The "UX" that matters is the API contract: clear SSE event types (token, tool_call, approval_required, final, error) and predictable error/refusal responses.

## 8. Deployment
- Local: `docker compose` (Postgres + pgvector) and the three Nest apps.
- Optional (post-MVP): AWS deployment (App Runner or ECS + RDS — decision pending) with real metrics (p95 latency, cost per conversation, eval score) documented in the README. Budget alert configured on the AWS account from day one.
