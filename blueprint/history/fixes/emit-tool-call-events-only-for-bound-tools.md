# Fix: Emit tool_call events only for bound tools

**Type:** Fix
**Status:** verified
**Branch:** fix/emit-tool-call-events-only-for-bound-tools
**Fixes:** F-05

## The problem

The locked SSE contract says `tool_call.data.name` is `list_orders` or `get_order`.
In `runToolLoop` ([chat.service.ts](apps/orderops-agent/src/chat/chat.service.ts)),
the loop emits `tool_call` with `call.name as ToolName` before `runTool` checks
whether the tool exists. A hallucinated tool name reaches clients as a
contract-violating event, and the `unknown_tool` branch in `runTool` has no test.

## The fix

Emit `tool_call` only when `call.name` matches one of the bound `tools`; still call
`runTool` for every call so the model gets its `unknown_tool` result back and can
recover. No new abstraction: a single `tools.some(...)` guard around the existing
`yield`.

- Must not break: event order and shape for valid calls (`tool_call` then the
  tool result feeding the next turn), the `MAX_MODEL_TURNS` bound, and the
  `final`/`error` terminal event guarantee.

## Build steps

- [x] 1. Guard the `tool_call` yield on the tool being bound, and add one unit
  test in `chat.service.spec.ts` where the model requests an unknown tool name.
  **Done when:** the new test asserts no `tool_call` event is emitted for the
  unknown name, the model receives a `ToolMessage` with `{"error":"unknown_tool"}`,
  and the stream still ends with a `final` event; existing tests still pass.

## Verify

- `npm test` and `npm run test:e2e` pass, including the new test.
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit` and `npm run lint` are clean.
- Optional live check: `POST :3000/chat` for an order still streams `tool_call`
  events with `list_orders`/`get_order` names.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":1759,"specSha256":"e336e60d14c565a9aba325a3a14d3f7f59a05cb103b28f77f83e6bfd81bca377","branch":"refs/heads/fix/emit-tool-call-events-only-for-bound-tools","head":"33f2f6791f671af53213b22119f9b712a8ca3efc","baseRef":"refs/heads/master","baseCommit":"33f2f6791f671af53213b22119f9b712a8ca3efc","sourceTree":"ba5ec0e9cc7f7fb9158a7f3aad6ccb9a5c548bb1","absentOptional":[]} -->

## Findings

### emit-tool-call-events-only-for-bound-tools/F-05 [P3] closed - tool_call event forwards unchecked model tool names

**File:** apps/orderops-agent/src/chat/chat.service.ts:112
**Found:** 2026-09-28 by /audit independent (scope: current; lens: quality, tests)
**Why it matters:** The locked SSE contract says `tool_call.data.name` is `list_orders` or `get_order`, but the loop casts `call.name as ToolName` and emits whatever name the model produced before `runTool` falls back to `unknown_tool` (line 129). A hallucinated tool name would reach clients as a contract-violating event that items 2-7 build on. The `unknown_tool` branch also has no test.
**Suggested fix:** Emit `tool_call` only for names of the bound tools (or look the tool up first and skip the event for unknown names while still returning `unknown_tool` to the model), and add one unit test for an unknown tool name. No current requirement is lost.
**Resolution:** runToolLoop emits tool_call only for bound tools; unknown names still get unknown_tool back. Unit test added in chat.service.spec.ts. Fixed in fix/emit-tool-call-events-only-for-bound-tools. Re-reviewed by /audit 2026-09-30: guard sits before the only tool_call yield, unknown names still reach runTool, new test covers the branch; no new defect.
