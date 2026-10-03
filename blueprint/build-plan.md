# OrderOps Agent — Build Plan

- [x] 1. Order lookup chat - authenticated SSE chat endpoint where the agent answers "where is my order?" by calling orders-service via LangChain tool calling, propagating the user's token, with Zod-validated structured output (includes both mock services and seed data)
  - [x] 1a. Mock services and login - customers-service and orders-service backed by Postgres via Prisma with seed data, a gateway login endpoint that issues JWTs, and services that validate the token and return only the caller's own data
  - [x] 1b. SSE order chat - authenticated SSE chat endpoint where the agent answers "where is my order?" by calling orders-service via LangChain tool calling with the user's token, with Zod-validated structured output
- [x] 2. Routed agent graph - LangGraph intent router with FAQ route (deterministic RAG over policy docs in pgvector), order route and out-of-scope refusal route
- [x] 3. Conversational memory - multi-turn threads persisted with the Postgres checkpointer, long-term per-user memory, and context trimming/summarization
- [x] 4. Guarded refunds - refund requests with business rules enforced in code, output validation with bounded retry, human approval via interrupt(), and deterministic fallback on agent failure
  - [x] 4a. Refund rules and request route - RefundRequest storage in the gateway, business rules enforced in code (delivered order, 30-day window, amount <= total, no other open request), refund route in the graph with structured extraction, output validation with bounded retry, deterministic fallback when the agent fails, and pending_approval requests created
  - [x] 4b. Operator approval - operator identity, human approval via interrupt(), approve/reject endpoints that resume the thread, and the approval_required SSE event
- [x] 5. Multi-provider models - Anthropic, OpenAI and Bedrock behind one interface, cheap-vs-strong model routing, and provider failover
- [x] 6. Traces and cost - per-request tracing of agent decisions, tools, tokens, p95 latency and cost per conversation, plus prompt caching
- [ ] 7. Regression evals - ~40-case eval dataset, tool/trajectory/answer/guardrail metrics, versioned results, CI workflow, and provider comparison table
  - [x] 7a. Eval harness and dataset - ~40-case dataset (normal, out-of-scope, adversarial), a runner that drives the real agent graph against a chosen provider with deterministic fake orders data and in-memory stores, route/tool-selection, trajectory and guardrail metrics, and versioned results in evals/results/*.json
  - [ ] 7b. Answer quality and provider comparison - LLM-as-judge answer-quality metric with a fixed rubric, and a provider comparison table generated from the versioned results
  - [ ] 7c. Eval CI - GitHub Actions workflow: keyless deterministic subset on pull requests, live-provider run on manual dispatch or schedule with repo secrets and a case/cost cap, and a regression check against the last committed results

## Post-MVP
- [ ] 8. AWS deploy - app running on AWS with real metrics documented in the README
