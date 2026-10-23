# Feature: Customer chat with agent timeline

**From build-plan:** feature 11a
**Build attempt:** 1
**Branch:** feature/customer-chat-with-agent-timeline
**Status:** verified

## Goal

A Next.js demo console in `/web` where a reviewer logs in with one click as a seeded demo customer, chats with the agent over the existing SSE stream, and sees, next to every assistant message, a live timeline of what the agent did: route, tool calls, provider and model, failovers, tokens, cost and latency. Per the owner's decisions: the browser talks only to the Next.js server, which holds the gateway JWT in an httpOnly cookie and proxies login and chat (no CORS change on the gateway); the console runs locally and is ready for Vercel, but is **not** deployed publicly in 11a (item 12's rate limits and cost budget come first); and the gateway's `trace` event gains a `model` field so the panel can show it.

## In scope

- **Gateway `trace` event**: add `model: string | null` to `TraceSummary`, the model of the last completed call, mirroring how `provider` is chosen today (null when no call completed). Additive; no other field changes.
- **New app `/web`**: Next.js (App Router, TypeScript, `src/` dir, plain CSS, no Tailwind or ESLint), its own `package.json` and lockfile, version pinned in step 1. Dev server on port **3005** (the gateway owns 3000). Root `vitest.config.ts` excludes `web/**`; `.dockerignore` excludes `web` so the Nest images do not change.
- **Server proxy (route handlers)**, all same-origin:
  - `POST /api/login` `{ email }`: accepts only the three seeded customer emails (`ana@example.com`, `ben@example.com`, `cora@example.com`), logs in at the gateway with the server-only `DEMO_PASSWORD`, stores the token in an httpOnly cookie. Operator and viewer emails are rejected, so the one-click login cannot hand out elevated roles.
  - `POST /api/logout`: clears the session cookies.
  - `GET /api/session`: `{ email }` for a live session, 401 otherwise.
  - `POST /api/chat` `{ message, threadId? }`: forwards only those two fields to the gateway `POST /chat` with `Authorization: Bearer <cookie token>` and streams the gateway's SSE body back unchanged; aborting the browser request aborts the upstream request.
- **Browser UI** (one page):
  - Login view: three buttons labelled with the seeded name and email (Ana Torres, Ben Carter, Cora Diaz).
  - Chat view: message list, a labelled input (1-2000 characters, Enter sends, disabled while a reply streams), live streamed text from `token` events, `tool_call` events shown as they arrive, the `approval_required` notice ("Refund request … waits for operator approval"), `final` replacing the streamed text with the final answer, `error` shown as its message, "New conversation" (drops `threadId`), and "Log out".
  - Timeline panel per assistant message: while streaming, a running state with the tool calls so far; after `trace`, route, tools, provider and model, failovers, tokens (input, output, cache read, cache write), cost (`costUsd`, or "not priced" with the `unpriced` count), latency, status and trace id. Selecting a message shows its panel; the latest is selected by default. On narrow screens the panel stacks below the chat.
- **States**: empty conversation (hint plus two example questions), streaming, stream error, network failure, aborted reply, and session expired (gateway 401 → cookies cleared, back to the login view with a notice).
- **Checks**: `web` scripts `dev`, `build`, `start`, `typecheck`, `test` (Vitest); root `npm run lint` also covers `web/src`; a `web` job in `.github/workflows/ci.yml` (install, typecheck, test, build; no secrets).
- **Docs**: `AGENTS.md` (web commands, env, port, `trace.model`), README (one paragraph), `web/.env.example`, and a short "Demo console (Vercel)" section in `docs/deploy.md`: Root Directory `web`, `API_URL` and `DEMO_PASSWORD`, and that public deployment waits for item 12.

## Out of scope

- Public deployment, the Vercel project, and Cloudflare DNS for `demo.arielbailon.dev` (after item 12; owner actions).
- Operator console (11b), observability dashboard and Langfuse links (11c), and any operator or viewer login in the console.
- CORS, rate limiting, cost budget, demo-data reset, demo credentials on screen (item 12).
- Loading earlier messages of a thread after a page reload (the gateway has no history endpoint); a reload starts a new conversation.
- Markdown rendering of answers; changes to the agent, graph, or any SSE event other than the added `trace.model`.
- Changing `provider` selection or F-22's call order (the panel does not read stored calls).

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. Step 2 needs network access (checking the current Next.js release and installing `/web` packages from npm); approving this spec authorizes that. Gates are `manual`; this feature adds a new trust boundary (a server that holds customer tokens), so `/audit independent current` before `/complete` is recommended and will be offered. The browser check at the end needs the local stack running and is done with the owner.

## Build steps

- [x] 1. Gateway `trace.model`. Add `model` to `TraceSummary` and `summarize` in `trace/trace-recorder.ts`. Done when: `trace-recorder.spec.ts` shows the last completed call's model and null with no completed call, `chat.e2e-spec.ts` asserts the `trace` event carries `model`, and the three app typechecks, `npm test` and `npm run test:e2e` pass.
- [x] 2. Scaffold `/web`. Check the current stable Next.js release (`npm view next version`) and the `create-next-app --help` flags, scaffold with TypeScript, App Router, `src/`, no Tailwind, no ESLint, skip install, then install with `npx -y npm@11 install` inside `web/` and add Vitest as a dev dependency. Set the dev port to 3005, exclude `web/**` in the root Vitest config, add `web` to `.dockerignore`, extend the root `lint` script to `web/src`. Done when: `npm run dev` in `web/` serves a placeholder page on :3005, `web` `typecheck`, `test` (one trivial spec) and `build` pass, and root `npm run lint` and `npm test` pass with the same counts as before plus nothing from `web`.
- [x] 3. Server proxy. `web/src/lib/` config (reads `API_URL`, default `http://localhost:3000`, and required `DEMO_PASSWORD`; missing password fails the route with a 500 that names no secret) and session cookie helpers; the four route handlers above. Done when: Vitest specs with a mocked `fetch` show: login rejects operator, viewer and unknown emails with 400 without calling the gateway; a successful login sets an httpOnly, SameSite=Lax, path `/` cookie (Secure in production) whose max-age matches `expiresIn`; gateway 401 on login maps to 401; chat without a cookie returns 401 without calling the gateway; chat forwards only `message` and `threadId` with the bearer token and returns the upstream SSE body and `text/event-stream` content type unchanged; upstream 401 clears the cookies and returns 401; upstream unreachable returns 502 `{ message }`; aborting the request aborts the upstream fetch; a non-JSON body returns 400.
- [x] 4. Stream parsing and conversation state. A framework-free SSE parser (`web/src/lib/sse.ts`) and a reducer (`web/src/lib/conversation.ts`) that turns `token`, `tool_call`, `approval_required`, `final`, `error` and `trace` events into per-message state. Done when: specs show events split across chunk boundaries and several events in one chunk parse correctly, unknown event types are ignored, `final` replaces streamed text and stores `threadId`, `error` marks the message failed with its message, `trace` fills the timeline (including `costUsd: null` with `unpriced`), and an aborted or cut-off stream leaves the message marked interrupted rather than running forever.
- [x] 5. UI. Login view, chat view and timeline panel wired to the proxy and the reducer, with the states above. All agent and customer text is rendered as plain React text (never `dangerouslySetInnerHTML`). The input has a visible label; the streaming status and errors are announced through an `aria-live` region; after sending, focus stays in the input; after login, focus moves to the input. Done when: `web` typecheck, test and build pass, and the owner-run browser check below is recorded.
- [x] 6. CI and docs. The `web` job in `ci.yml`, `web/.env.example`, and the `AGENTS.md`, README and `docs/deploy.md` changes above. Done when: the workflow YAML parses, `AGENTS.md` names the web commands, port, env and the `trace.model` field, and `git diff` touches only files listed in this spec.

## Browser check (after step 5, with the owner)

With the local stack running (Postgres, the three apps, `web` dev server on :3005, `DEMO_PASSWORD` set in `web/.env.local`): log in as Ana, ask an order question, and confirm streamed text, the `list_orders` tool in the panel while streaming, then route, provider, model, tokens, cost and latency after the reply. Ask a refund question for a delivered order and confirm the approval notice. Log out and confirm the login view returns. Stop the gateway and send a message to confirm the network-failure state. Results are recorded in the final report; anything not observed is reported as not observed.

**Observed 2026-10-23** (owner, local stack, Chrome):

- Logged in as Ana; an order thread listed her three orders, and a refund request for ORD-1001 was auto-rejected by the 30-day rule with its reference shown (no approval notice, which only appears for a stored `pending_approval` request; not observed in this run).
- The timeline of the refund reply showed route `refund`, tool `get_order`, `anthropic / claude-haiku-4-5-20251001` (the last call's model, the memory step), failovers 0, tokens 7,100 in / 463 out, cost $0.022947, latency 7,391 ms, status `ok` and the trace id; the selected reply was highlighted.
- The owner reported the remaining checks (live running state with tools, switching the panel between replies, new conversation, log out, gateway stopped, narrow layout) as working, without per-row detail.
- Known and accepted for 11a: answers show the agent's markdown (`**bold**`, `- ` lists) as plain text (markdown rendering is out of scope), and the panel's model is the last completed call's.

## Files / areas

- Changed: `apps/orderops-agent/src/chat/chat.schemas.ts`, `apps/orderops-agent/src/trace/trace-recorder.ts` (+ spec), `apps/orderops-agent/test/chat.e2e-spec.ts`, `vitest.config.ts`, `.dockerignore`, `package.json` (root `lint` script only), `.github/workflows/ci.yml`, `AGENTS.md`, `README.md`, `docs/deploy.md`.
- New: `web/` (scaffold, `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `.env.example`, `src/app/` page, layout, styles, `src/app/api/{login,logout,session,chat}/route.ts`, `src/lib/{config,session,sse,conversation}.ts` with specs, UI components under `src/components/`).
- Untouched: the graph and nodes, other SSE events, the observability API, the Langfuse wiring, the mock services, Prisma schema and migrations, the deploy workflow and Caddy.

## Data / contracts

- **`trace` SSE event**: adds `model: string | null` (last completed call's model; null when none completed). Existing fields unchanged.
- **Session cookies** (set only by the Next.js server): `orderops_token` (the gateway JWT; httpOnly, SameSite=Lax, path `/`, Secure when `NODE_ENV=production`, max-age = gateway `expiresIn`) and `orderops_email` (same flags; the logged-in demo email for `GET /api/session`). The JWT is never returned to browser JavaScript.
- **Proxy routes** (JSON in and out except the chat stream): `POST /api/login` → 200 `{ email }` | 400 `{ message }` (not a demo customer, bad body) | 401 (gateway rejected) | 502 (gateway unreachable); `POST /api/logout` → 204; `GET /api/session` → 200 `{ email }` | 401; `POST /api/chat` → the gateway's SSE stream | 400 (bad body; message 1-2000 chars, `threadId` a uuid when present) | 401 (no or expired session, cookies cleared) | 502 (gateway unreachable).
- **Env (web, server-only)**: `API_URL` (gateway base URL, default `http://localhost:3000`), `DEMO_PASSWORD` (required; the seeded demo password). Neither is exposed with a `NEXT_PUBLIC_` prefix.
- **Rendering**: customer and agent text is shown as plain text only.

## Testing

Gateway: `trace-recorder.spec.ts` and the chat e2e for `trace.model`. Web: Vitest specs for the proxy routes (mocked `fetch`), the SSE parser and the reducer. Run once at the end: `npm run lint`, the three app typechecks, `npm run typecheck:spec`, `npm test`, `npm run test:e2e`, and in `web/`: `npm run typecheck`, `npm test`, `npm run build`. The UI itself has no automated browser test (no Browser tests command); its behavior is proven only by the owner-run browser check, and the report says so.

## Notes for the AI

- Read the installed Next.js docs or types for route handler streaming and cookies before step 3; do not guess the API from memory. Return the upstream `Response.body` as the stream; do not buffer it.
- Never log, return or embed the JWT or `DEMO_PASSWORD`; never prefix them with `NEXT_PUBLIC_`.
- Keep the proxy closed: fixed upstream paths only (`/auth/login`, `/chat`), never a path or URL taken from the request.
- Install with `npx -y npm@11 install` (the bundled npm crashes on the root project); never edit lockfiles by hand.
- The gateway listens on 3000; the console uses 3005. Do not start dev servers yourself; ask the owner.
- Add no AI attribution to commits; never commit, push or deploy from `/implement`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":13639,"specSha256":"52c35525a7c732edeb69f8b65f43d33b4fd3d3878dc4a41c05604fa50ab48029","branch":"refs/heads/feature/customer-chat-with-agent-timeline","head":"c1b2cf720e3504122631199bfc7f36d33c7ae409","baseRef":"refs/heads/master","baseCommit":"c1b2cf720e3504122631199bfc7f36d33c7ae409","sourceTree":"7c0626796f686d5ca1a5fc98d0dd22ca5c07fda5","absentOptional":[]} -->
