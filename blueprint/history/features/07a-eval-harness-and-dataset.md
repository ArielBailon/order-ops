# Feature: Eval harness and dataset

**From build-plan:** feature 7a
**Build attempt:** 1
**Branch:** feature/eval-harness-and-dataset
**Status:** verified

## Goal

A repeatable regression eval for the agent: a ~40-case dataset (normal,
out-of-scope, adversarial), a runner that drives the real agent graph against one
chosen provider with deterministic fake services, deterministic metrics (route,
tool selection, trajectory, guardrails), and versioned result files in
`evals/results/`. Answer quality by LLM judge and the provider comparison table
are 7b; CI is 7c.

## In scope

- `evals/dataset.json`: about 40 cases, each `{ id, category, customer, turns[],
  expect }`, validated by a Zod schema. Categories: `normal` (~20: order lookup,
  FAQ, refunds incl. code-rule rejections), `out_of_scope` (~8), `adversarial`
  (~12: prompt injection, another customer's order, system-prompt extraction,
  claiming operator approval, refund above total, refund of an undelivered order,
  made-up order ids).
- Deterministic fakes under `apps/orderops-agent/src/evals/`:
  - three customers with fixed orders (delivered inside and outside the 30-day
    window, shipped, pending), and a fake `OrdersClient` that, like orders-service,
    returns only the caller's own orders (`not_found` otherwise); the "token" is the
    customer id.
  - in-memory `RefundStore`, in-memory `UserMemoryStore`, `MemorySaver`.
  - FAQ retrieval over the real `policies/*.md` chunks using a simple keyword
    scorer (no pgvector, no embeddings, no keys); the eval scores the agent, not
    retrieval.
  - a fixed clock (`NOW`) passed to the graph so the refund window is stable.
- A runner that builds the real graph (`buildAgentGraph`) with models from the
  provider layer for exactly one provider (`createChatModel(provider, 'cheap' |
  'strong')`, no failover, so a result is attributable), runs every case with a
  fresh thread, captures SSE-equivalent events, and collects model calls with the
  feature-6 `TraceCollector` (tokens, latency, estimated cost).
- Metrics (all deterministic, no model judging):
  - **route**: final event route equals `expect.route` (last turn).
  - **tools**: the set of tool names called equals `expect.tools` (empty means none),
    and `orderId` args match when `expect.toolArgs` gives them.
  - **trajectory**: ordered tool-call names equal `expect.tools` as a sequence, and
    the stream ends with exactly one `final` and no `error`.
  - **guardrail**: every constraint in `expect.guardrail` holds: `refund` outcome
    (`pending_approval` | `auto_rejected` | `none`, read from the final event),
    `approvalRequired` event present or absent, `mustNotInclude` strings absent from
    the answer (for example another customer's order id or a canary phrase), and for
    `out_of_scope` the fixed refusal text. Cases without a guardrail block are not
    counted in this metric.
  - Overall and per-category pass rates for each metric, plus a case pass flag
    (all applicable metrics pass).
- Versioned results: `evals/results/<UTC timestamp>-<provider>.json` with
  `{ schemaVersion, runAt, gitSha, datasetSha256, provider, models, summary, cases[] }`;
  each case keeps its metric flags, route, tool names, answer text, events count,
  and tokens/cost/latency. Results are meant to be committed.
- CLI: `npm run eval -- --provider anthropic|openai|bedrock [--ids a,b] [--category
  normal|out_of_scope|adversarial] [--limit N]`. `--provider` is required (live runs
  cost money; there is no default). Prints a per-metric summary and the written file
  path; exits non-zero only on a runner/config error, not on failed cases (gating is
  7c).
- Unit tests with scripted fake chat models; docs in AGENTS.md Commands.

## Out of scope

- LLM-as-judge answer quality and the provider comparison table (7b); GitHub Actions
  and any regression gate or thresholds (7c).
- Re-running cases for flakiness statistics, parallel execution, a UI, or retries.
- Evaluating retrieval quality, embeddings, the real databases, JWT/auth, or the
  operator approval endpoints (the graph pause is checked only as the
  `approval_required` event).
- Changing agent behavior to make cases pass; a failing case is a recorded result.
- Failover testing (the eval pins one provider).

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement
all steps, then review once as a single packet. No per-step pauses or checkpoint
commits; `/complete` creates the final commit.

## Build steps

- [x] 1. Fixtures and fakes. Add `apps/orderops-agent/src/evals/fixtures.ts`
  (customers, orders, `NOW`) and `fakes.ts` (owner-scoped fake orders client,
  in-memory refund and memory stores, keyword policy search over the real policy
  chunks).
  **Done when:** specs prove: a customer cannot read another's order (`not_found`),
  `listOrders` returns only own orders, the refund store enforces one open request
  per order like the real one, the keyword search returns the returns-policy chunk
  for a returns question; `npm test` passes.
- [x] 2. Dataset and schema. Add `evals/dataset.json` (~40 cases) and
  `apps/orderops-agent/src/evals/dataset.ts` (Zod schema, loader, SHA-256 of the
  file bytes).
  **Done when:** a spec proves: the file validates, ids are unique, there are at
  least 18 normal, 6 out-of-scope and 10 adversarial cases, every order id in
  `expect`/`mustNotInclude` exists in the fixtures, and every case whose expected
  refund outcome is `auto_rejected` or `pending_approval` agrees with
  `evaluateRefund` applied to the fixtures at `NOW`; `npm test` passes.
- [x] 3. Runner. Add `evals/run.ts` (name per repo convention under `src/evals/`):
  builds the graph with the chosen provider's cheap/strong models and the fakes,
  runs each case (all turns in one fresh thread, per-case timeout), captures events,
  route, tool names, refund summary, answer text, and `TraceCollector` calls. A case
  that throws or times out is recorded as a run error, never a crash.
  **Done when:** a spec with scripted fake chat models proves: events and tool names
  are captured in order, multi-turn cases share one thread, usage/cost come from
  scripted `usage_metadata`, and a throwing model yields a recorded error for that
  case while later cases still run; `npm test` passes.
- [x] 4. Metrics and aggregation. Add `metrics.ts`: pure functions for route, tools,
  trajectory and guardrail plus overall/per-category summary.
  **Done when:** specs with hand-built case runs prove each metric passes and fails
  on the documented conditions, cases without a guardrail block are excluded from
  that metric, and summary rates and per-category splits are correct; `npm test`
  passes.
- [x] 5. CLI and results. Add `evals/cli.ts` with argument parsing and the results
  writer, `npm run eval`, and `evals/results/.gitkeep`.
  **Done when:** specs prove: missing or unknown `--provider` is rejected, filters
  select the right cases, the written JSON matches the documented shape and file
  name, and the dataset hash and git sha fields are filled; `npm test`, `npx tsc -p
  apps/orderops-agent/tsconfig.app.json --noEmit`, `npm run typecheck:spec`,
  `npm run lint` and `npm run test:e2e` pass. A live run (`npm run eval -- --provider
  <p> --limit 3`) is reported as manual evidence only if actually run with real keys.
- [x] 6. Docs. Add the eval command, its flags and the results location to AGENTS.md
  Commands.
  **Done when:** AGENTS.md describes the shipped behavior.

- [x] 7. Repair F-13: runner timeout test. A scripted model whose call stalls until
  aborted proves a timed-out case is recorded as `TimeoutError` and later cases still run.
  **Done when:** `run.spec.ts` covers it; `npm test` passes.

## Files / areas

- New: `evals/dataset.json`, `evals/results/.gitkeep`,
  `apps/orderops-agent/src/evals/` (fixtures, fakes, dataset, runner, metrics,
  cli, specs).
- Changed: `package.json` (script), `AGENTS.md`. Reused unchanged:
  `agent/agent.graph.ts`, `models/providers.ts`, `trace/trace-recorder.ts`,
  `refunds/refund-rules.ts`, `faq/policy-chunks.ts`.

## Data / contracts

- Case: `{ id: string, category: 'normal'|'out_of_scope'|'adversarial', customer:
  'ana'|'ben'|'cora', turns: string[] (1+ customer messages), expect: { route:
  'faq'|'order'|'refund'|'out_of_scope', tools: string[], toolArgs?: { orderId?:
  string }[], guardrail?: { refund?: 'pending_approval'|'auto_rejected'|'none',
  approvalRequired?: boolean, mustNotInclude?: string[], refusal?: boolean,
  refundTarget?: { orderId: string, amount?: string } } } }`. `refundTarget` names the
  order (and amount, default the order total) a stored refund outcome refers to; the
  dataset spec checks it against `evaluateRefund`. Guardrail checks and `approvalRequired`
  apply to the last turn; `tools` and `toolArgs` (orderId by call position) to the whole case.
- Result file shape as listed in In scope; `schemaVersion: 1`; timestamps are UTC ISO
  with `:` replaced by `-` in the file name; `gitSha` is the short HEAD sha or
  `unknown`.
- Results contain only fake fixture data and model output: no keys, no real customers.
  API keys come from the environment and are never written to results or logs.
- Model output is non-deterministic: a single run per case is a sample, not proof.

## Testing

- Vitest unit specs with scripted fake chat models for runner, metrics, CLI and
  fakes; the dataset spec checks internal consistency against the real refund rules.
- Real provider behavior (which cases pass, cost, latency) needs keys and money and is
  manual evidence only. No browser coverage (API-first).

## Notes for the AI

- Drive the graph through `buildAgentGraph` with `streamMode: 'custom'` exactly as
  `ChatService.reply` does; pass `callbacks: [collector]` and the `configurable`
  `{ token, customerId, thread_id }` shape. Prefer reusing `TraceCollector`.
- Use `AgentDeps.now` for the fixed clock; do not add a clock abstraction.
- Provider pinning: build `cheap`/`strong` with `createChatModel`, not
  `createFailoverModel`. Wrap prompts as they already are (`cacheableSystem` is
  handled by the failover wrapper only; with a single raw model it sends the marked
  message untouched, so check each provider accepts it, or route through a
  single-candidate `createFailoverModel` so provider-specific rewriting still runs).
- Dataset authoring is part of this feature: write realistic, varied phrasings; keep
  expected values derivable from fixtures and the written policies.
- CRLF repo: format only files you touch; do not run `prettier --write` on the whole
  app.
- Use `npx -y npm@11 install` if a dependency is needed (none expected).

## Open questions

- **Dataset review.** The ~40 cases and their expected routes/tools/guardrails are
  authored by the implementer from the fixtures and policies. Skim `evals/dataset.json`
  at review; wrong expectations become false regressions.
- **Committing results.** Proposed: committed (versioned in the repo, as the plan
  says). Confirm no size or privacy concern with committing per-case answer text
  (fake data only).


<!-- blueprint:completion {"schemaVersion":1,"specBytes":11134,"specSha256":"0cdc0fd3a48f9c38e37487b97f7318228fbccbf9fc284cad8a71c58c51920038","branch":"refs/heads/feature/eval-harness-and-dataset","head":"fde5a37166111feb0b9d71961ee431a0e1a1387b","baseRef":"refs/heads/master","baseCommit":"fde5a37166111feb0b9d71961ee431a0e1a1387b","sourceTree":"24f4007328a1a32cfb0657947933a3a775794508","absentOptional":[]} -->

## Findings

### 7a/F-10 [P3] closed - Conversation cost report groups by thread id alone

**File:** apps/orderops-agent/src/trace/report-traces.ts:42
**Found:** 2026-10-03 by /audit independent (scope: current; lens: quality)
**Why it matters:** `ChatTrace.threadId` is the client-supplied thread uuid, while the checkpoint key is prefixed with the customer id, so two customers using the same uuid are separate conversations. The per-conversation cost query groups by `threadId` only and would merge them, skewing the conversation count, average and max. Reachable only by a client reusing a uuid; the effect is limited to report accuracy.
**Suggested fix:** `GROUP BY t."customerId", t."threadId"`. Nothing is lost.
**Resolution:** 2026-10-03 fix/group-cost-report-by-customer-and-thread: the per-conversation cost query now groups by `t."customerId", t."threadId"`, and `ConversationRow` carries `customerId`. Checked live against the dev database with two throwaway traces sharing a thread id but with different customers: the old query printed `conversations  1`, the new one prints `2`; the rows were deleted afterward. Awaiting `/audit` re-review. Closed 2026-10-03 by /audit current (re-review of fde5a37): the query now selects and groups by `customerId` and `threadId`, `ConversationRow` matches it, and the surrounding report code introduced no new defect. Live proof from the repair stands (old query 1 conversation, new query 2, throwaway rows deleted); not re-run here.

### 7a/F-13 [P3] closed - Runner timeout path has no test

**File:** apps/orderops-agent/src/evals/run.ts:96
**Found:** 2026-10-03 by /audit (scope: current; lens: tests)
**Why it matters:** The spec says a case that throws or times out is recorded as a run error and later cases still run. `run.spec.ts` proves only the throwing-model branch. The per-case `AbortSignal.timeout` and the way an abort surfaces from the graph (error name, no crash, no hang) are unexercised, so a regression there would show up only in a live run that costs money.
**Suggested fix:** Add a spec with a scripted model whose structured call waits on the abort signal and `timeoutMs` of a few tens of milliseconds; assert `error` is set, `streamOk` is false and a following case still runs. Nothing is lost.
**Resolution:** 2026-10-03: added a `run.spec.ts` case where a scripted model's routing call stalls until aborted; with `timeoutMs: 50` the case is recorded with `error: 'TimeoutError'`, `route: null`, `streamOk: false`, and the next case still runs. Awaiting `/audit` re-review. Closed 2026-10-03 by /audit current: `run.spec.ts` now proves a stalled call ends as `TimeoutError` with a later case still running; the scripted `HANG` path ends only on abort and introduced no new defect. The eval specs passed three runs in a row, so no flakiness was seen.
