# Feature: Rate limits and origin lock

**From build-plan:** feature 12b
**Build attempt:** 1
**Branch:** feature/rate-limits-and-origin-lock
**Status:** verified

## Goal

Limit how fast one visitor can hit the public demo before the console goes live. The console (Vercel) limits its login, chat and refund routes per client IP. The gateway limits chat per customer as a backstop, because the gateway is public at `api.arielbailon.dev` and anyone with a demo token can skip the console. The gateway keeps CORS off: the console calls it server-side, so no browser origin ever needs access, and a test proves no CORS header is sent. Per the owner's decisions, counters live in memory (one-minute fixed window, no new dependency or service), and the limits are the "moderate" set below. The 12a daily budget stays the hard money cap.

## In scope

- **Console per-IP limits** (`web/`), one-minute fixed window per client IP and group:
  - `login`, 10 per minute: `POST /api/login`, `POST /api/operator/login`, `POST /api/viewer/login` (one shared counter).
  - `chat`, 10 per minute: `POST /api/chat`.
  - `refunds`, 60 per minute: `GET /api/refunds/[id]`, `GET /api/operator/refunds`, `POST /api/operator/refunds/[id]/approve|reject` (one shared counter; the customer's 5-second refund poll alone uses 12 per minute).
  - Over the limit: `429` `{ message: "Too many requests. Try again in N seconds." }` with a `Retry-After: N` header (whole seconds until the window ends, at least 1). Checked first, before reading the body or calling the gateway, so a limited request costs nothing upstream.
  - Client IP: the `x-real-ip` header (Vercel sets it to the connecting client), else the first `x-forwarded-for` entry, else the fixed key `unknown` (local dev, where every request then shares one counter).
- **Gateway per-customer chat limit** (`orderops-agent`): 30 `POST /chat` requests per minute per `customerId` from the verified JWT (fixed window, in memory; the gateway runs as one container, so the count is exact). Checked in the controller after the guard and body validation and before the SSE headers are sent. Over the limit: `429` JSON `{ statusCode: 429, message: "Too many chat messages. Try again in N seconds." }` with `Retry-After: N`. No agent run, no model or orders call, no checkpointer write, no `ChatTrace` (the request is rejected like a 400, before the agent). The console's chat route maps a gateway 429 to its own 429 with the fixed console message and passes `Retry-After` through.
- **Memory bound**: each limiter drops expired windows whenever it holds more than 10,000 keys, so rotating IPs cannot grow memory without limit.
- **CORS off, proven**: the gateway keeps no `enableCors`. An e2e test sends a preflight `OPTIONS /chat` and a `POST /auth/login`, both with `Origin: https://evil.example`, and asserts neither response carries `access-control-allow-origin` or `access-control-allow-credentials`.
- **Docs**: `AGENTS.md` (console limits per group, gateway limit, 429 shape, IP source, best-effort per-instance note, CORS off), `docs/deploy.md` "Demo console (Vercel)" (limits are per instance and best effort; the gateway limit and `DAILY_BUDGET_USD` are the caps; set the budget before going public), README one line.

## Out of scope

- Shared counters across Vercel instances (Redis, Vercel Firewall rules); limits on the viewer data routes, logout or session routes.
- Per-IP limits on the gateway itself, or limits on `/auth/login`, refunds or observability at the gateway.
- Making limits configurable through env.
- Recording rate-limited requests as traces or metrics; alerts.
- Demo data reset and visible credentials (12c); deploying the console.
- Any UI change: the chat, login, operator and dashboard views already show the server's `message` on a failed request, and the refund poll silently retries a failed tick.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. No new dependency and no migration. Gates are `manual`. Evidence is unit, route and e2e tests; no live browser check is planned because nothing visible changes (a 429 shows through existing error paths).

## Build steps

- [x] 1. Gateway chat limit. A `FixedWindowLimiter` (limit, window ms, injectable clock; `hit(key)` returns `{ allowed: true }` or `{ allowed: false, retryAfterSeconds }`; sweeps expired keys past 10,000) in `apps/orderops-agent/src/chat/`, provided as `CHAT_RATE_LIMIT` (30 per 60 s) in `chat.module.ts` and used by `ChatController.stream`. Done when: a limiter spec with a fixed clock shows the 30th hit allowed and the 31st refused with the right `retryAfterSeconds`, a new window allows again, keys are independent, and the sweep drops only expired keys; a chat e2e case (limiter overridden with limit 1) shows the second request answers 429 with the JSON body and `Retry-After`, a different customer is still allowed, and the agent and trace store are not called for the refused request; the three app typechecks, `npm run typecheck:spec`, `npm test` and `npm run test:e2e` pass.
- [x] 2. CORS proof. An e2e spec (`apps/orderops-agent/test/cors.e2e-spec.ts`) for the preflight and the login request with a foreign `Origin`. Done when: both assertions pass in `npm run test:e2e`, and `main.ts` is unchanged.
- [x] 3. Console limits. `web/src/lib/rate-limit.ts` (same fixed-window limiter, `clientIp(request)`, and `rateLimited(request, group)` returning the 429 response or null), called first in the six route handlers above; `POST /api/chat` maps a gateway 429. Done when: a `rate-limit` spec shows the IP order (`x-real-ip`, then first `x-forwarded-for`, then `unknown`), the window and `Retry-After`; route specs show the 11th login (mixing customer and operator login) and the 11th chat from one IP get 429 without calling the gateway (fetch mock not called), another IP is still allowed, the 61st refund request gets 429, and a gateway 429 on chat becomes a console 429 with the fixed message and `Retry-After`; `web` typecheck, test and build pass; `npm run lint` passes.
- [x] 4. Docs. Done when: `AGENTS.md`, `docs/deploy.md` and the README describe the limits, the 429 shape and the per-instance caveat as in scope; `git diff` touches only files listed in this spec.

## Files / areas

- `apps/orderops-agent/src/chat/rate-limit.ts` (+ `.spec.ts`), `chat.module.ts`, `chat.controller.ts` (+ `chat.controller.spec.ts`, new constructor argument)
- `apps/orderops-agent/test/chat-rate-limit.e2e-spec.ts`, `apps/orderops-agent/test/cors.e2e-spec.ts`
- `web/src/lib/rate-limit.ts` (+ `.spec.ts`)
- `web/src/app/api/login/route.ts`, `operator/login/route.ts`, `viewer/login/route.ts`, `chat/route.ts`, `refunds/[id]/route.ts`, `operator/refunds/route.ts`, `operator/refunds/[id]/[decision]/route.ts`
- `web/src/app/api/limits.spec.ts` (new, the route-level limit cases); `proxy.spec.ts`, `operator.spec.ts`, `viewer.spec.ts` (limiter reset between tests, login handlers now take the request)
- `AGENTS.md`, `docs/deploy.md`, `README.md`

## Data / contracts

- Console 429: status 429, header `Retry-After: <integer seconds, >= 1>`, body `{ "message": "Too many requests. Try again in <N> seconds." }`. Same for every limited console route.
- Gateway 429 on `POST /chat`: status 429, `Content-Type: application/json`, header `Retry-After`, body `{ "statusCode": 429, "message": "Too many chat messages. Try again in <N> seconds." }`. Sent instead of the SSE stream; no `final`, `trace` or `ChatTrace`.
- Window: fixed, 60,000 ms, starting at the first hit for a key; the count resets when it ends. `Retry-After` = ceil(ms until the window ends / 1000), minimum 1.
- Limits are code constants: console login 10, chat 10, refunds 60 per IP; gateway chat 30 per customer.
- No persisted data, no new env variable, no new dependency.

## Testing

- Unit (Vitest): both limiters with a fixed clock; `clientIp` header order.
- Route specs (`web`, Vitest): limits per group across routes, independent IPs, the gateway 429 mapping; each spec resets limiter state between tests (export a reset for tests or build the limiter per test through a seam).
- E2E (`npm run test:e2e`, needs the local Postgres container like the other e2e specs): gateway 429 and CORS headers.
- Not run: shared limits across Vercel instances (not provided by this design).

## Notes for the AI

- Module-level limiter state is intentional in `web/`: it lives as long as the Vercel instance. Tests must not leak counts between cases.
- Count only requests that reach the limit check; in the gateway, invalid tokens (401) and invalid bodies (400) are rejected earlier and do not count.
- Do not trust `x-forwarded-for` anywhere in the gateway; the gateway key is the JWT `customerId` only.
- Keep the two limiters small and alike (web and the gateway are separate packages with no shared library); no abstraction beyond `hit(key)`.
- Express answers an unrouted `OPTIONS` with 404; the CORS test asserts header absence, not a status.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":9086,"specSha256":"c2df4b3ed61b3bdb024934b0bdf493620a43c4ce199c43dae4ac18c4b06400c9","branch":"refs/heads/feature/rate-limits-and-origin-lock","head":"833d15296ef98882a3a242eb47129cf154e16b5f","baseRef":"refs/heads/master","baseCommit":"833d15296ef98882a3a242eb47129cf154e16b5f","sourceTree":"5c1fc2c3cc99da69250528f1daa143be517da958","absentOptional":[]} -->
