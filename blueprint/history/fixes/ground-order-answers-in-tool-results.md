# Fix: Ground order answers in tool results

**Type:** Fix
**Status:** verified
**Branch:** fix/ground-order-answers-in-tool-results

## The problem

Found while running the whole flow on AWS Bedrock (2026-10-16). In the order
route, a follow-up on an existing thread ("And what is its total?" after "Where
is order ORD-1003?") made Claude Sonnet 4.5 answer **without calling any tool**
and invent the total ($249.99 and $299.99 in two runs; the real total is $199.00).
The reply had `orderIds: []`, the sign that nothing came from a tool. The
conversation history holds only the earlier final answers, not the tool results,
so the model has no order data on a follow-up and `runToolLoop` accepts a model
turn with zero tool calls. The same flow on Claude Sonnet 5 through the
Anthropic API happened to call the tool and answered correctly, so this is a
latent gap that any provider (including the Bedrock failover) can hit.

## The fix

Make the first model turn of the order route always call a tool, in code,
instead of trusting the prompt: the route exists to answer questions about the
customer's own orders, and every such answer needs facts from the order tools.

- `apps/orderops-agent/src/agent/order-route.ts`: give `runToolLoop` an optional
  `forceFirstToolCall` flag. When set, the first turn binds the tools with
  `tool_choice: 'any'` (a tool must be called; LangChain maps it per provider,
  `required` on OpenAI); later turns bind normally so the model can answer after
  the tool result. `runOrderRoute` passes `true`. The refund route and every
  other caller keep the current behavior.
- Do not add a new abstraction, retry loop, or validator. Leave the prompts as
  they are.

Must not break: normal order lookups and "order not found" answers, the
`tool_call` SSE events, `MAX_MODEL_TURNS`, the refund route, and the eval
runner (it drives the same route).

## Build steps

- [x] 1. Force a tool call on the first order-route turn, with tests. Done when:
  a unit test shows the first turn binds tools with `tool_choice: 'any'` and a
  second turn without it, a test with a fake model that would otherwise answer
  without a tool still ends with a tool call before the answer, the refund route
  test still binds without a forced choice, and
  `npx vitest run apps/orderops-agent/src` passes.

## Verify

- `npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck:spec`,
  `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`, `npm run build`.
- Live (needs the three apps running and `AWS_REGION=us-east-1`; use
  `PORT=3010` while another container holds port 3000): with only Bedrock
  enabled (invalid Anthropic and OpenAI keys in the process environment), ask
  "Where is order ORD-1003?" and then, on the same thread, "And what is its
  total?". Expect a `tool_call` event on both turns and `$199.00`. Repeat the
  follow-up three times. Then run the same on the default providers to check
  nothing regressed. The Anthropic-direct and OpenAI paths are exercised only if
  their keys are valid.
- If a provider rejects `tool_choice: 'any'` in the live check, stop and report
  instead of widening the change.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3154,"specSha256":"c94800dae0a13e2fbaf716428e5a15af0564c591be8402bd26086f0aec3ed3f7","branch":"refs/heads/fix/ground-order-answers-in-tool-results","head":"968f02b74e27f7fae70d7cd33d97ff7184f50b38","baseRef":"refs/heads/master","baseCommit":"968f02b74e27f7fae70d7cd33d97ff7184f50b38","sourceTree":"c1c70168d89fb0f8708268cb3f061e0a87cc841c","absentOptional":[]} -->
