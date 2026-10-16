# Fix: Post-decision refund behaviors

**Type:** Fix
**Status:** verified
**Branch:** fix/post-decision-refund-behaviors

## The problem

Found while running the README walkthrough against the live system (2026-10-16):

1. **An approved refund does not block another one.** `evaluateRefund` only
   checks for an open (`pending_approval`) request, so after an operator
   approves a refund for ORD-1001, the customer can file a new request for the
   same order and a second `pending_approval` row is created (observed in
   `RefundRequest`). Two approvals would refund the same order twice.
2. **A follow-up about the refund is routed as a new refund request.** After the
   decision, "What happened with my refund?" on the same thread was classified
   as `refund` by `classifyIntent`, because the router prompt treats any
   message about a refund as the refund route and the thread history is about a
   refund. The refund route then created a new request instead of answering.

## The fix

1. **Block re-refunds after approval (root cause: the rule set).**
   - `apps/orderops-agent/src/refunds/refund-rules.ts`: add rule code
     `already_refunded`. The rule order becomes `not_delivered`, `window_expired`,
     `amount_exceeds_total`, `already_refunded`, `open_request_exists`. Add a
     boolean `alreadyRefunded` to `RefundCheck`.
   - `refund.store.ts`: add `hasApprovedForOrder(orderId): Promise<boolean>`
     (a row with `status = 'approved'` for that order) to `RefundStore` and the
     Prisma store.
   - `refund-route.ts`: call it next to `findOpenForOrder`, pass the result to
     `evaluateRefund`, and add a fixed rejection text for `already_refunded`
     ("Order X already has an approved refund."). The outcome is stored as an
     `auto_rejected` request like the other rule codes, with
     `decisionReason: 'already_refunded'`.
   - Decision recorded: any approved request on the order blocks new ones, since
     the project has no partial-refund accounting. A `rejected` or
     `auto_rejected` request does not block.
   - Update the in-memory eval store (`evals/fakes.ts`) and the test doubles
     that implement or mock `RefundStore`.
2. **Do not treat refund status questions as new requests.**
   - `agent/router.ts`: in `ROUTER_PROMPT`, state that the refund route is only
     for a message that asks to start a new refund, and that a question about
     the status or outcome of a refund already requested ("what happened with my
     refund?") belongs to `order`, where the model answers from the earlier turns
     of the conversation. Do not add code or new routes.
   - Must not break: policy questions about refunds stay `faq`; first refund
     requests stay `refund`.

## Build steps

- [x] 1. Re-refund rule: add `already_refunded` to the rules, the store, the
  refund route, the eval fake and the test doubles, with tests. Done when:
  `refund-rules.spec.ts` covers the new code and rule order, `refund-route.spec.ts`
  covers an approved prior request producing an `auto_rejected` reply, and
  `npx vitest run apps/orderops-agent/src/refunds apps/orderops-agent/src/agent apps/orderops-agent/src/evals apps/orderops-agent/src/chat`
  passes.
- [x] 2. Router prompt: add the status-question rule. Done when: a unit test
  asserts the prompt contains the rule, and the live check below classifies the
  status question as `order` and the first request as `refund`.

## Verify

- `npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck:spec`,
  `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`, `npm run build`.
- Live (needs the three apps running, keys in `.env`; port 3000 may need
  `PORT=3010`): make ORD-1001 recent with the README SQL, request a refund as
  Ana, approve it as the operator, then (a) request a refund for ORD-1001 again:
  expect `refund.status: "auto_rejected"` and no new `pending_approval` row;
  (b) on the same thread ask "What happened with my refund?": expect
  `route: "order"` and no new `RefundRequest` row. Reset the demo data after
  (README "Reset the demo data").
- The answer to (b) comes from the model, not fixed text. If it is unhelpful, say
  so in the handoff rather than adding a new feature.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":4206,"specSha256":"1cf9f96a04a44728ac925e599cec565b567ff4812f854b41e36b27f90dd06a91","branch":"refs/heads/fix/post-decision-refund-behaviors","head":"c74fdb19de901cfa7dc6db594f6a67442990d4fb","baseRef":"refs/heads/master","baseCommit":"c74fdb19de901cfa7dc6db594f6a67442990d4fb","sourceTree":"74d3b8f8273615c37ecfb86feb9077acbf87dfd9","absentOptional":[]} -->
