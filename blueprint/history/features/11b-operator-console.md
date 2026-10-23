# Feature: Operator console

**From build-plan:** feature 11b
**Build attempt:** 1
**Branch:** feature/operator-console
**Status:** verified

## Goal

An operator page in the demo console (`/operator`) where a reviewer logs in with one click as the seeded operator, sees the pending refund requests, and approves or rejects them; the existing gateway endpoints store the decision and resume the customer's paused thread. In the customer chat (11a), a reply that left a refund waiting for approval watches that request and shows the decision as soon as it is made. Per the owner's decision, the customer side learns the outcome by **polling a new customer-only refund status endpoint** on the gateway, which returns the same fixed approved/declined text the gateway writes into the thread. Markdown rendering stays out of scope.

## In scope

- **Gateway: customer refund status**. `GET /refunds/mine/:id` (customer JWT; any role, scoped to the caller): `{ id, orderId, amount, status, message }` for one of the caller's own refund requests; 404 for an unknown id or another customer's request (no difference between the two). `message` is `REFUND_REPLIES.approved(...)` or `REFUND_REPLIES.declined(...)` once decided, null otherwise. A new store method `findForCustomer(id, customerId)` reads one row by id and owner; the eval fakes implement it too. It lives in its own controller so the operator guard on `/refunds` stays unchanged.
- **Console: operator session**, separate from the customer session so a customer tab and an operator tab work side by side in one browser:
  - `POST /api/operator/login` `{}`: logs in only as `operator@example.com` with the server-only `DEMO_PASSWORD`; cookies `orderops_operator_token` and `orderops_operator_email`, same flags as 11a.
  - `POST /api/operator/logout`, `GET /api/operator/session`.
  - The customer login (`/api/login`) keeps rejecting the operator email; the operator login accepts nothing else.
- **Console: operator proxy routes**, closed like 11a's:
  - `GET /api/operator/refunds` → gateway `GET /refunds/pending` with the operator token.
  - `POST /api/operator/refunds/[id]/[decision]` with `decision` one of `approve` | `reject` and `id` matching `^[A-Za-z0-9_-]{1,100}$` → gateway `POST /refunds/:id/approve|reject`. Any other decision value or id shape is 400 without a gateway call.
  - Gateway 401 clears the operator cookies and returns 401; 403, 404 and 409 are passed through as `{ message }` with a fixed operator-facing text; unreachable is 502.
- **Console: customer refund status route**. `GET /api/refunds/[id]` → gateway `GET /refunds/mine/:id` with the customer token, same id rule, same 401/404/502 handling.
- **Operator page** (`/operator`):
  - Logged out: one button "Log in as Sam Operator (operator@example.com)" and a link back to the customer chat.
  - Logged in: the pending list, oldest first, each with order id, customer id, amount, submitted time, and the customer's reason shown as quoted plain text labelled as the customer's words (it is untrusted). Approve and Reject buttons per row; both disabled while that row's decision is in flight.
  - After a decision: the row leaves the list and a status line says "Approved refund … for order …" or "Rejected …". 409 (already decided) and 404 (gone) refresh the list and say so; 403 says operators cannot decide their own request.
  - A Refresh button; no automatic refresh on this page.
  - States: loading, empty ("No refund requests are waiting."), list error with retry, session expired (back to the operator login with a notice), "Log out".
- **Customer chat (11a) additions**:
  - The reducer also keeps `final.refund` (`{ id, status }`); a reply whose `approval_required` event or `final.refund.status === 'pending_approval'` names a request starts watching it.
  - While at least one watched request is undecided, the chat polls `GET /api/refunds/[id]` every 5 seconds per request. When the status becomes `approved` or `rejected`, it adds the returned `message` to the conversation as an operator update (visually distinct from agent replies and with no timeline), announces it through the `aria-live` region, and stops watching that request. Polling stops on 404, on logout, on "New conversation" and on unmount; 401 ends the session as in 11a; a failed poll is retried on the next tick without a visible error.
- **Docs**: `AGENTS.md` (new endpoint, operator page and routes, the two sessions), README (the side-by-side demo: customer tab, operator tab), and the console paragraph.

## Out of scope

- Markdown rendering of agent answers (owner decision; a later `/fix`).
- Any change to the approve/reject endpoints, the decision rules, the thread resume behavior, or the `approval_required` event.
- A thread history endpoint or reloading earlier messages after a page reload.
- Push (SSE or WebSocket) delivery of decisions; automatic refresh of the operator list.
- Viewer login and the observability dashboard (11c); public deployment, rate limits and CORS (item 12).
- Showing customer names or emails in the operator list (the pending endpoint returns the customer id only).

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. No new dependency is needed. Gates are `manual`; this feature gives the console an operator token and a new gateway read endpoint, so `/audit independent current` before `/complete` is recommended and will be offered. The browser check at the end needs the local stack and is done with the owner.

## Build steps

- [x] 1. Gateway refund status. `findForCustomer` on `RefundStore`, the Prisma store and the eval fakes; a `MyRefundsController` (`@Controller('refunds/mine')`, `JwtAuthGuard` only) registered next to the approvals controller. Done when: store spec shows the owner's row is returned and another customer's id gives null; an e2e spec shows 200 with `message: null` for a pending own request, 200 with the approved text after an operator approves it, 404 for another customer's request and for an unknown id, 401 without a token, and that `GET /refunds/pending` still answers 403 to a customer; the three app typechecks, `npm test` and `npm run test:e2e` pass.
- [x] 2. Console operator session and proxy routes. Generalize the cookie helpers in `web/src/lib/server.ts` to a session kind (`customer` | `operator`) without changing the customer cookie names; add the operator login, logout, session, refunds list and decision routes, and the customer `GET /api/refunds/[id]`. Done when: Vitest specs with a mocked `fetch` show the operator login calls the gateway only with `operator@example.com` and sets the operator cookies (not the customer ones); the customer login still rejects the operator email; the list and decision routes return 401 without an operator cookie even when a customer cookie is present, forward to the exact gateway path with the operator token, reject a bad decision or id with 400 without calling the gateway, pass 403/404/409 through as `{ message }`, clear the operator cookies on a gateway 401, and return 502 when unreachable; the customer status route forwards with the customer token and handles 401/404/502 the same way.
- [x] 3. Customer chat polling. Reducer: keep `final.refund`, track watched requests, and add an `operator_update` message. A small hook or effect in `chat-view.tsx` polls as described. Done when: reducer specs show a reply with `approval_required` or `final.refund.status: 'pending_approval'` becomes watched, `auto_rejected` does not, a decided status adds exactly one operator update with the returned message and stops watching, a 404 stops watching without a message, and reset clears watches; `web` typecheck and tests pass.
- [x] 4. Operator page. `web/src/app/operator/page.tsx` and its components with the states above; the reason rendered as plain React text inside a quote; a link between the two pages. Done when: `web` typecheck, test and build pass, and the owner-run browser check below is recorded.
- [x] 5. Docs. Done when: `AGENTS.md` names `GET /refunds/mine/:id` with its response and 404 rule, the operator page and its routes, and the separate operator session; README describes the side-by-side demo; `git diff` touches only files listed in this spec.

## Browser check (after step 4, with the owner)

With the local stack and the console running: in tab 1 log in as Ana and ask for a refund on an order that qualifies (delivered within 30 days, for example by running `npx prisma db seed` first so the dates are fresh, or using an order the owner knows qualifies) and confirm the approval notice. In tab 2 open `/operator`, log in as Sam, confirm the request is listed with its reason quoted, and approve it. Back in tab 1, within about 5 seconds, confirm the operator update with the approved text appears. Repeat with Reject on another request if one qualifies. Log out of the operator page and confirm the customer tab is still logged in. Anything not observed is reported as not observed.

**Observed 2026-10-23** (driven with Playwright in Chromium at the owner's request; local stack started for the run and stopped afterwards; with the owner's approval, the local delivery dates of ORD-1001 and ORD-2003 were moved to three days earlier so both qualified):

- Tab 1, Ana: "I want a refund for ORD-1001, the keyboard arrived broken" stored `ref_a7b8d2e4-…` and showed the approval notice; focus stayed in the message box.
- Tab 2, `/operator`: started logged out although the customer cookies were present (separate sessions); after "Log in as Sam Operator" the list showed ORD-1001, `cus_ana`, $89.90, the submit time and the reason in the "Customer's words (unverified)" quote.
- Approve removed the row, the status line read "Approved refund ref_a7b8d2e4-… for order ORD-1001.", focus moved to the list heading, and the empty state appeared.
- Tab 1 showed the operator update "Update on refund request ref_a7b8d2e4-…: our team approved your refund of 89.90 USD for order ORD-1001." within the polling interval, announced through the live region; it was styled apart from agent replies and had no timeline.
- Tab 1 as Ben: a refund for ORD-2003 (`ref_4a2a9805-…`, $45.00) was listed after Refresh and rejected; tab 1 then showed "…our team declined your refund of 45.00 USD for order ORD-2003."
- Logging out of the operator page kept the customer logged in (a reload still showed "Logged in as ben@example.com").
- Browser console: only the expected favicon 404 and the logged-out `/api/session` 401s on load; no errors from polling or decisions.
- Not exercised live: the 403 (own request), 404/409 race and session-expiry paths of the operator page (covered by route specs only), and the narrow layout of the operator page. Minor UX note: Refresh keeps the previous decision's status line.

## Files / areas

- Changed (gateway): `apps/orderops-agent/src/refunds/refund.store.ts` (+ spec), `apps/orderops-agent/src/evals/` fake refund store, `apps/orderops-agent/src/approvals/approvals.module.ts`, `apps/orderops-agent/test/approvals.e2e-spec.ts` (or a new `my-refunds.e2e-spec.ts`).
- New (gateway): `apps/orderops-agent/src/approvals/my-refunds.controller.ts`.
- Changed (console): `web/src/lib/server.ts`, `web/src/lib/conversation.ts` (+ spec), `web/src/components/chat-view.tsx`, `web/src/components/login-view.tsx` (link to the operator page), `web/src/app/api/proxy.spec.ts` (or new spec files), `web/src/app/globals.css`.
- New (console): `web/src/app/api/operator/{login,logout,session,refunds}/route.ts`, `web/src/app/api/operator/refunds/[id]/[decision]/route.ts`, `web/src/app/api/refunds/[id]/route.ts`, `web/src/app/operator/page.tsx`, operator components under `web/src/components/`.
- Docs: `AGENTS.md`, `README.md`.
- Untouched: the approve/reject endpoints and their rules, `ChatService.resumeRefund`, the graph, Prisma schema and migrations, the observability API, CI and deploy files.

## Data / contracts

- **`GET /refunds/mine/:id`** (gateway, any authenticated role, owner-scoped): 200 `{ id: string, orderId: string, amount: string /* "89.90" */, status: 'pending_approval' | 'approved' | 'rejected' | 'auto_rejected', message: string | null }`; 404 for unknown or not-owned ids; 401 without a valid token; `id` validated like the approvals controller (1-100 chars). `message` is the fixed decision text for `approved` and `rejected`, null otherwise. No customer reason or operator id is returned.
- **Operator cookies**: `orderops_operator_token`, `orderops_operator_email`; httpOnly, SameSite=Lax, path `/`, Secure in production, max-age = gateway `expiresIn`. The operator token never reaches browser JavaScript and is never used for `/api/chat` or `/api/refunds/[id]`; the customer token is never used for operator routes.
- **Console routes**: `POST /api/operator/login` → 200 `{ email }` | 401 | 502 | 500 (not configured); `POST /api/operator/logout` → 204; `GET /api/operator/session` → 200 `{ email }` | 401; `GET /api/operator/refunds` → 200 `{ refunds: PendingRefund[] }` | 401 | 502; `POST /api/operator/refunds/[id]/[decision]` → 200 `{ id, status, decidedBy }` | 400 | 401 | 403 | 404 | 409 | 502; `GET /api/refunds/[id]` → 200 (gateway body) | 400 | 401 | 404 | 502.
- **Polling**: every 5 seconds per watched request, only while the chat view is mounted and the request is undecided; no backoff (demo traffic, local stack; rate limits are item 12).
- **Rendering**: the customer's refund reason and all agent and operator-update text are plain React text.

## Testing

Gateway: refund store spec for `findForCustomer`; e2e for the new endpoint's 200/404/401 cases and the unchanged operator guard. Console: Vitest specs for the operator routes and the customer status route (mocked `fetch`), and reducer specs for watching and operator updates. Run once at the end: `npm run lint`, the three app typechecks, `npm run typecheck:spec`, `npm test`, `npm run test:e2e`, and in `web/`: `npm run typecheck`, `npm test`, `npm run build`. The two-tab flow is proven only by the owner-run browser check.

## Notes for the AI

- Keep the existing operator endpoints byte-for-byte; the new endpoint is a separate controller with only `JwtAuthGuard`.
- Return 404 for another customer's refund exactly as for an unknown id; never reveal that the id exists.
- Reuse `REFUND_REPLIES.approved` / `.declined` for `message`; do not copy the text into the console.
- Keep the console proxy closed: fixed upstream paths, ids checked against the pattern, then `encodeURIComponent`.
- The two sessions must not leak into each other's routes; test it.
- Install nothing new. Never commit, push or deploy from `/implement`; add no AI attribution.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":14824,"specSha256":"867acb78a8a48068724fa6151d7c04eb4b17792be0882500032df4749fa7bbcd","branch":"refs/heads/feature/operator-console","head":"a731e17aee3623e4042caf8b79e800d6c5c75096","baseRef":"refs/heads/master","baseCommit":"a731e17aee3623e4042caf8b79e800d6c5c75096","sourceTree":"947104e54e11bde4b0d548340cc2f38a83c5f72b","absentOptional":[]} -->
