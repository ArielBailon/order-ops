# AGENTS.md

Instructions for AI coding agents working in this project. This is the cross-tool
entry point: Codex, OpenCode, Cursor, GitHub Copilot, Gemini CLI, Aider, Zed,
Windsurf, and others read `AGENTS.md`. Claude Code reads `CLAUDE.md`, which imports
this file, so there is a single source of truth.

Claude Code, Codex, and every other AI tool must not add AI attribution to
commits or pull requests, including AI `Co-Authored-By` trailers or generated-by
signatures. Preserve genuine human attribution. See
[Commit and PR attribution](blueprint/context/ai-interaction.md#commit-and-pr-attribution)
for optional tool settings.

## What this is

OrderOps Agent: a support and operations agent for a fictional e-commerce store,
built with NestJS + LangChain.js + LangGraph.js. It is a guided learning and
portfolio project for production agentic patterns: state-graph orchestration,
tool calling against authenticated microservices, memory, guardrails,
multi-provider models (Anthropic, OpenAI, AWS Bedrock), observability, and evals.

NestJS monorepo (Nest CLI native mode) with three apps under `apps/`:

- `orderops-agent` - gateway + agent (default project)
- `orders-service` - mock orders microservice
- `customers-service` - mock customers microservice

This project is built with the **AI Blueprint**, a workflow layer, not an
app skeleton. To start a new project, scaffold the app first in an empty folder
(create-next-app, Vite, etc.), then overlay these files on top. Never run a
framework scaffolder inside a directory that already holds the blueprint files
(`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`, `blueprint/`); it fails
because the directory isn't empty.

The workflow is defined by the local skills and context files below.

## Proportional engineering

Build for established requirements, not hypothetical scale, threats, or future
flexibility. Reuse existing code, the standard library, native platform features,
and installed dependencies before adding machinery.

- Unknown scale or extensibility defaults to the smaller reversible design. Do
  not infer enterprise, multi-tenant, hostile-user, or compliance requirements.
- Derive trust and data-integrity boundaries from actual reachability: untrusted
  input, auth/session/ownership, shared persisted data, destructive operations,
  payments, secrets, and sensitive data.
- Ask only when an unknown materially changes behavior, architecture, persisted
  data, interoperability, a real security boundary, or cost. Otherwise choose the
  simplest repository-native implementation.
- Add an abstraction, dependency, service, configuration surface, compatibility
  layer, or security mechanism only for a current requirement.
- Simplicity never removes real trust-boundary validation, data-loss prevention,
  accessibility, explicit security requirements, configured tests, or project rules.
- Stack-specific template standards apply only when the project uses that stack.

## Read these when relevant

- `blueprint/config.json` - deterministic project workflow settings
- `blueprint/context/project-overview.md` - the project's source of truth
- `blueprint/context/coding-standards.md` - read before changing code
- `blueprint/context/ai-interaction.md` - read when running the Blueprint workflow
- `blueprint/context/current-feature.md` - the one feature, fix, or rollback being built right now

Reuse relevant context already loaded in the session. Claude Code imports only
this file; its Blueprint skills load the other files on demand.

## Project configuration

`blueprint/config.json` is the user-owned, machine-readable workflow policy for
this project. Workflow skills read the relevant settings before acting. A
missing file means built-in defaults. An invalid file falls back to defaults for
read-only status reporting, but mutating workflow commands stop and point to
`/doctor` instead of guessing.

Configuration can make review or verification stricter and can tune local
branch names and automated-mode limits. It never grants permission to commit,
merge, push, deploy, publish, send, delete data, waive a failing check, or accept
a finding. Those approval and safety boundaries are not configurable.

`qualityGates.regular` controls automatic audit, independent-review, check, and
try-guide behavior for the normal workflow and Autopilot.
`qualityGates.continuous` controls the same per-feature gates for Continuous
Mode. The existing `tryGuide` keys select `/check guide`, which generates
instructions without performing verification or recording acceptance.
Independent review defaults to `when-sensitive` in both workflows, while
audit, check, and try guide default to `manual`. Sensitive or unusually broad
work therefore selects independent review automatically; ordinary small work
does not. Setting a workflow's independent review to `manual` disables that
automatic selection, while an explicit `/audit independent current` remains
available. The other conditional modes are `when-sensitive` for audit,
`when-behavioral` for check, and `when-user-facing` for try guides. `always`
runs the gate for every work item in that workflow.

`review.independentExecution` controls how a selected independent-review gate
runs. Its default, `automatic`, uses a fresh isolated reviewer child when the
active adapter can prove isolation, exact reviewer identity and model, and
completion. Otherwise it preserves the request and falls back to the manual
handoff. This setting changes execution only; the quality-gate policy still
decides whether review is selected.
The automatic path spawns a generic child through the current runtime and gives
it the installed project-local Audit skill and review contract. It never requires
or discovers global agent roles, skills, prompts, or TraversyFlow components.
New review requests record requested execution and completed receipts record
actual execution. Manual uses `fresh session`; automatic uses `fresh subagent`;
an explicit automatic fallback records actual manual with `fresh session`.

New projects default to one review packet after all small implementation steps
(`workflow.stepReview: "feature"`) with step checkpoint commits disabled. This
keeps the normal loop reviewable without repeating the full session context after
every step. Set `stepReview` to `every` when teaching, pairing closely, or working
on a high-risk change. That restores the per-step approval pauses. To fully
restore the previous workflow, including optional checkpoint prompts after an
approved step, also set `checkpointCommits` to `enabled`. Onboarding presents
these pairs as Efficient and Guided choices, but stores only the two low-level
settings. They can be changed at any time. Both styles end with an optional
read-only code walkthrough. Review cadence controls approval pauses, not whether
the user can ask for an explanation of the finished implementation.

## Workflow

Build one feature, fix, or rollback at a time, behind review gates. Each step's instructions
are plain markdown skills any capable agent can read and follow. The workflow is
exposed through tool-specific adapters:

- Codex: `.agents/skills/<skill>/SKILL.md`
- Claude Code: `.claude/skills/<skill>/SKILL.md`
- GitHub Copilot: `AGENTS.md` plus `.agents/skills/<skill>/SKILL.md`
- OpenCode: `AGENTS.md` plus the compatible `.agents/skills/` or
  `.claude/skills/` tree already installed for the selected tools

Unused adapters can be removed. Codex, GitHub Copilot, and OpenCode can share
`.agents/`. OpenCode can also reuse `.claude/` when Claude Code is selected.
Codex-only, Copilot-only, or OpenCode-only projects can delete `CLAUDE.md` and
`.claude/`. Claude Code-only projects can delete `.agents/`, but should keep
`AGENTS.md` because `CLAUDE.md` imports it. Do not duplicate the same Blueprint
skills under `.opencode/skills/`; OpenCode already discovers the compatible
trees.

When changing shared workflow behavior, update the matching skill in both
adapter folders so Codex, Claude Code, GitHub Copilot, and OpenCode stay aligned.

Learn the feature loop: `/feature` -> `/implement` -> `/check` -> `/audit current` ->
`/complete`. Approve the Feature spec before Implement. Check proves behavior;
Audit reviews code and records findings. Showing both in this path does not
change configured gates or make Audit mandatory. `/check guide` only generates
manual instructions and never performs verification or records acceptance.

Core skills:

### Build

- `feature` - turn a build-plan item into a spec, or propose a reviewed plan addition for a genuinely new feature
- `implement` - build the current spec one small, reviewed step at a time
- `check` - prove the current spec against the running app, or use `check guide`
  for a read-only manual review guide: where to go, what to click, what to expect
- `complete` - run the final safety pass, log features, fixes, or rollbacks under `blueprint/history/`, then merge with approval

### Understand and review

- `explore` - investigate an idea against the actual code without writing files or requiring plans
- `brief` - read-only briefing on an upcoming build-plan feature (scope, dependencies, size) before you spec it
- `status` - read-only progress summary, workflow drift warning, and suggested next action
- `debug` - reproduce and isolate a failure without editing code, then hand the evidence to `fix` or `implement`
- `audit` - branch-aware or full-project review across all concerns or a focused quality, security, performance, or tests lens; `audit independent current` prepares an immutable checkpoint for a fresh reviewer session or configured isolated reviewer child; records findings in `blueprint/context/findings.md` and independent receipts in `blueprint/context/review.md`, where blocking findings or stale review state stop `complete`
- `doctor` - Blueprint health check for setup, adapters, plans, overview freshness, dashboard state, and workflow drift; it may offer to reset only malformed generated dashboard state after approval

### Plan and set up

- `onboard` - tune commands, standards, visibility, ignore rules, and tool adapters after overlaying the Blueprint onto a freshly scaffolded or early project
- `adopt` - bootstrap the Blueprint into an existing brownfield app with shipped features
- `discovery` - optional deep, multi-turn planning conversation that drafts the two user-owned plans only after review and approval; direct plan writing remains fully supported
- `overview` - distill the two planning docs into
  `blueprint/context/project-overview.md`, then offer a reviewed initial planning
  baseline commit before Feature 1
- `prototype` - optional, pre-build static mockups to lock the look
- `tests` - set up unit testing by default, or a repeatable browser harness with `tests browser`
- `ci` - explicitly set up one project-specific Verify command and matching automatic GitHub checks, with an optional local pre-push hook

### Recover and release

- `fix` - document an ad-hoc bug or change into `blueprint/context/current-feature.md`
- `rollback` - plan a safe reversal of a completed feature from its archive and exact git commit, with later-dependency review before code changes
- `release` - optional Render or Vercel deployment readiness, local config, env review, and smoke-test planning

In Codex, invoke these as skills (`$onboard`, `$discovery`, `$overview`, `$feature`,
`$implement`, and so on) or ask naturally, such as "run the overview." In Claude
Code, use the slash commands (`/onboard`, `/discovery`, `/overview`, `/feature`,
and so on). These are AI chat commands, not terminal commands. In OpenCode or
other tools without a dedicated invocation syntax, ask the agent to run the matching skill or follow its `SKILL.md` manually. The
conventions in `blueprint/context/` apply however a step is invoked. `/discovery`
is never required: users may write detailed plans directly or develop them
through any conversation before running `/overview`.

### Automation

Optional explicit-only skill: `autopilot` combines `feature` or `fix` with
`implement` in one bounded pass when directly invoked, including the configured
regular quality gates. The normal workflow stops for human approval of the spec
before implementation; Autopilot continues through that review point. It may
create checkpoint commits on the feature or fix branch after passing steps and
repair confirmed P0/P1 findings when its audit gate runs. It stops before
`/complete`, merge, push, deploy, or destructive actions.

Optional explicit-only skill: `continuous` can resume or select the next planned
feature and repeat the complete local feature lifecycle through the configured
limit or end of the build plan. It creates one branch and one local main commit
per feature, applies the Continuous quality gates, archives and merges serially,
and stops on decisions or failed safety gates. It never pushes, deploys,
publishes, sends, or performs destructive actions.

Deployment is also explicit. `/release` can prepare local Render or Vercel config
and run readiness checks, but it must stop before deploy, remote service changes,
push, or publish unless the user gives a separate yes in the current chat.

## Dashboard activity

The dashboard can show the active or most recent substantial Blueprint command
from `blueprint/.state/run.json`. This file is generated local state, ignored by
Git, and never part of a feature commit.

Commands with meaningful progress or a durable handoff should write it when the
state directory exists: `onboard`, `adopt`, `discovery`, `overview`, `feature`,
`fix`, `rollback`, `implement`, `debug`, `check`, `audit`, `tests`,
`ci`, `prototype`, `autopilot`, `continuous`, `complete`, and
`release`. Short orientation commands such as `explore`, `brief`, `status`, and `doctor`
do not write activity state. The `check guide` mode also never writes activity
state; select the Check mode before any activity call. Doctor's optional
approved reset removes malformed activity instead of recording another run.

Writing the initial activity record is the first action of a tracked command,
before project inspection, preflight, or other tool calls. This one generated
state write does not authorize product changes or bypass any safety check.

Never create or edit `run.json` directly. From the project root, use the first
helper that exists:

```text
node .agents/skills/doctor/scripts/run-state.mjs <action> <options>
node .claude/skills/doctor/scripts/run-state.mjs <action> <options>
```

Start with `start --command <skill> --summary <truthful-summary> --boundary
<boundary>`. Use `update` at meaningful milestones or for a blocker, with
`--status blocked` and `--resume <exact-command>` when recovery is needed. End
with `finish --status ready|completed --summary <truthful-summary>`. The helper
validates every field before atomically replacing the generated file. If it is
missing or fails, report the activity warning and continue the workflow without
writing a manual fallback.

The helper writes this schema:

```json
{
  "schemaVersion": 1,
  "command": "continuous",
  "status": "running",
  "summary": "Completing the remaining build plan",
  "detail": "Implementing feature 3.",
  "boundary": "local-only",
  "startedAt": "<ISO-8601 timestamp>",
  "updatedAt": "<ISO-8601 timestamp>",
  "resumeCommand": "/continuous resume",
  "progress": { "current": 2, "total": 5, "label": "features" },
  "feature": { "id": "3", "title": "Export reports" }
}
```

`status` must be `running`, `blocked`, `ready`, or `completed`. Use `ready` when
the command reached its intended review handoff, such as Autopilot waiting for
review before `/complete`. Use `blocked` with the exact recovery command when
work can resume. `boundary` must be `read-only`, `reviewed`, or `local-only`.
The progress, feature, detail, boundary, and resume fields are optional. Never
put secrets, raw logs, prompts, or user content in this file. Activity tracking
must not change a command's approval boundaries or turn a reporting failure into
a workflow failure.

## Automatic verification

Automatic GitHub checks are a separate explicit setup. `/onboard` and `/adopt`
only report existing checks and point to `/ci` or `$ci` when none exist. Running
`/ci` inspects the real project and defines one `Verify` command from checks that
already exist. Use this order when available: typecheck, tests, then build. Never
invent a test runner or another check just to fill the command.

For JavaScript and TypeScript projects, prefer a package script such as `verify`
and use the detected package manager. For other stacks, use the native task
runner or exact combined command. Record the exact command under Commands below.

The optional `.github/workflows/verify.yml` must run that same command for pull
requests and pushes to the default branch. Preserve existing workflows, use the
project's real runtime and install command, and grant only `contents: read` by
default. This setup does not add coverage, browser tests, security scans, or
version matrices; those remain later project choices. A local pre-push hook that
runs the same `Verify` command is offered as an opt-in at the end of `/ci`, and
`git push --no-verify` still bypasses it, so the remote ruleset stays the lock.

GitHub branch protection or a ruleset can require the check after the repository
is pushed, but that is a separate remote setting. Missing automatic GitHub
checks do not make the Blueprint unusable.

## Commands

npm (lockfile: `package-lock.json`). Node's bundled npm 10.9.3 crashes during
install on this project (arborist `edgesOut` bug); use `npx -y npm@11 install`
until the global npm is updated.

- Env: copy `.env.example` to `.env` and set `JWT_SECRET` (32+ chars); every
  app validates its env at startup. Chat models fail over Anthropic -> OpenAI
  -> Bedrock (`AWS_REGION` set enables Bedrock; the other two keys stay
  required); tier model ids live in `apps/orderops-agent/src/models/providers.ts`
- Database: `docker compose up -d` (Postgres 16 + pgvector on `localhost:5432`)
- Migrate + seed: `npx prisma migrate dev`, `npx prisma generate`, then `npx prisma db seed`
  (idempotent). Seed customers `ana@example.com`, `ben@example.com`,
  `cora@example.com` share the dev password `orderops-dev-password`. Accounts and orders live in
  `prisma/demo-data.ts`; order dates are days before the moment the seed runs (ORD-1001 delivered
  5 days ago, inside the 30-day refund window; ORD-2003 60 days ago, outside it)
- Demo reset: `npm run demo:reset` (`prisma/demo-reset.ts`, one transaction) upserts the five demo
  accounts with the dev password and the seven orders with fresh relative dates, and deletes the
  refund requests, `UserMemory` and LangGraph checkpoint rows (`thread_id` `cus_ana:%`,
  `cus_ben:%`, `cus_cora:%`) of the three demo customers. It keeps `ChatTrace`/`LlmCall` (dashboard
  and daily budget), `cus_smoke`, every other customer and `policy_chunks`. Production runs it
  nightly at 04:00 UTC (`deploy/orderops-demo-reset.timer` -> `deploy/demo-reset.sh` -> compose job
  `demo-reset`). The console login screen shows `DEMO_PASSWORD` (it opens all five demo accounts,
  also on the public API)
- Policy index (FAQ route): `npm run ingest:policies` embeds
  `apps/orderops-agent/policies/*.md` into the `policy_chunks` pgvector table
  (needs `DATABASE_URL` and `OPENAI_API_KEY` in `.env`; replaces the whole
  index, so reruns are idempotent). Run it once before using the FAQ route;
  the gateway also requires `OPENAI_API_KEY` at startup
- Dev servers: `npm run start:all` starts all three in watch mode with
  prefixed output (Ctrl+C stops them all), or one at a time:
  `npm run start:dev` (gateway, :3000),
  `npm run start:dev -- orders-service` (:3001),
  `npm run start:dev -- customers-service` (:3002)
- Demo console (`web/`, Next.js 16, its own package and lockfile): `cd web && npx -y npm@11 install`,
  copy `web/.env.example` to `web/.env.local` and set `DEMO_PASSWORD` (the seed password) and
  `API_URL` (default `http://localhost:3000`), then `npm run dev` (:3005; the three apps must be
  running). Checks in `web/`: `npm run typecheck` (`next typegen` + `tsc`), `npm test` (Vitest,
  `src/**/*.spec.ts`), `npm run build`. The browser calls only the console's route handlers:
  `POST /api/login` (only the three seeded customers; the shared password also opens operator and
  viewer accounts), `POST /api/logout`, `GET /api/session`, and `POST /api/chat`, which streams the
  gateway's SSE unchanged. The gateway JWT stays in an httpOnly cookie (`orderops_token`) and never
  reaches browser JavaScript. Deployed on Vercel (Root Directory `web`, production branch `master`,
  previews on pull requests) at `https://demo.arielbailon.dev`, with the server-side env `API_URL`,
  `DEMO_PASSWORD` and `LANGFUSE_PROJECT_URL` set in the Vercel project (`docs/deploy.md` "Demo
  console (Vercel)"). Operator page `/operator`: one-click login as `operator@example.com` only, with
  its own cookies (`orderops_operator_token`) so a customer tab and an operator tab work side by
  side; routes `POST /api/operator/login`, `/api/operator/logout`, `GET /api/operator/session`,
  `GET /api/operator/refunds` and `POST /api/operator/refunds/[id]/approve|reject` (ids must
  match `^[A-Za-z0-9_-]{1,100}$`). A customer reply that leaves a refund pending polls
  `GET /api/refunds/[id]` (customer token, gateway `/refunds/mine/:id`) every 5 seconds and
  shows the decision as an operator update. Neither token is ever sent on the other side's routes.
  Dashboard `/dashboard`: one-click login as `viewer@example.com` only (cookies
  `orderops_viewer_token`, a third session beside customer and operator); Metrics (window 24h, 7d
  or 30d), Traces (route and status filters, 50 per page, detail with the model calls in call
  order) and Evals (latest run per provider). Routes `POST /api/viewer/login`, `/api/viewer/logout`,
  `GET /api/viewer/session`, `/api/viewer/summary?window=`, `/api/viewer/traces?route=&status=&before=`
  (anything else is 400), `/api/viewer/traces/[id]` (uuid) and `/api/viewer/evals`. Optional
  server-only `LANGFUSE_PROJECT_URL` in `web/.env.local` (for example
  `https://us.cloud.langfuse.com/project/<project-id>`) adds "Open in Langfuse" to the trace detail
- Login: `POST http://localhost:3000/auth/login` with `{ "email", "password" }`;
  send the returned `accessToken` as `Authorization: Bearer <token>` to
  `GET :3001/orders`, `GET :3001/orders/:id`, `GET :3002/customers/me`
- Chat: `POST http://localhost:3000/chat` with `{ "message", "threadId"? }` (uuid; omit to
  start a thread) streams SSE; the `final` event returns the `threadId` to send
  next. A `trace` event follows `final` (or `error`) on every reply still being read:
  `{ id, route, tools, provider, model, failovers, tokens: { input, output, cacheRead, cacheWrite },
  costUsd, unpriced, latencyMs, status }`, where `id` is the stored `ChatTrace` id (generated
  by the app), `provider` and `model` are the last completed call's (often the cheap memory
  step, not the model that wrote the answer), `failovers` counts failed calls another
  provider answered, and `costUsd` is a six-decimal string or null; metadata only, no message
  text. An aborted request sends none but is still recorded. The gateway creates its LangGraph checkpoint tables at startup in the
  same database; the `UserMemory`, `RefundRequest`, `ChatTrace` and `LlmCall` tables come from
  `npx prisma migrate deploy` (`migrate dev` reports drift from library-managed
  tables such as `policy_chunks` and asks to reset the database: do not)
- Refunds: a refund request in chat answers with `route: "refund"`; the `final`
  event carries `refund: { id, status }` (`pending_approval` or `auto_rejected`)
  when a request was stored or an open one reused. Rules (delivered, within 30 days
  of delivery, amount <= order total, one open request per order) are enforced in
  code. A newly stored `pending_approval` request streams `approval_required`
  (`{ refundId, orderId, amount }`) right before `final`, and its thread pauses
  with `interrupt()` until an operator decides
- Operators: seed operator `operator@example.com` (same dev password) logs in
  through `/auth/login`; its token carries `role: "operator"`. Send it to
  `GET :3000/refunds/pending` (reason is untrusted customer text),
  `POST :3000/refunds/:id/approve` and `POST :3000/refunds/:id/reject`
  (200 `{ id, status, decidedBy }`; 403 not an operator or own request, 404
  unknown, 409 not pending). The decision is stored first, then the paused
  thread is resumed so a fixed decision message lands in the conversation (if
  the customer wrote again first, the same message is appended to the thread
  instead, including when the client closed the stream early; a thread paused
  on a different request is left alone)
- Refund status for customers: `GET :3000/refunds/mine/:id` (any valid token, scoped to the
  caller) returns `{ id, orderId, amount, status, message }` for one of the caller's own refund
  requests; `message` is the same fixed approved/declined text the thread receives, null until an
  operator decides. Another customer's id answers 404 exactly like an unknown id. No reason or
  operator id is returned
- Observability API (read-only; `viewer` and `operator` tokens, 403 for customers): seed viewer
  `viewer@example.com` (same dev password, token `role: "viewer"`). `GET :3000/observability/summary?since=`
  (default last 7 days: latency p50/p95 overall and by route, cost per conversation, per-model totals,
  cached-token share, error and failover rates), `GET :3000/observability/traces?since=&until=&route=&status=&limit=&before=`
  (newest first, `limit` 1-200 default 50, `before` = a trace id from `nextBefore`; 400 for bad
  parameters or an unknown `before`), `GET :3000/observability/traces/:id` (one trace with its model
  calls in call order via `LlmCall.seq`, 404 unknown; traces stored before the `seq` migration keep a
  stable but arbitrary order) and
  `GET :3000/observability/evals/latest` (newest run per provider from `evals/results/*.json`,
  summaries only, no per-case answers; the files are baked into the image, so new results need a
  commit and a deploy). Metadata only, never message text. The report CLI and the API share
  `apps/orderops-agent/src/trace/trace-metrics.ts`
- Build: `npx nest build <app>` (`npm run build` builds only `orderops-agent`)
- Production server (gateway): `npm run build && npm run start:prod`
- Production compose (`docker-compose.prod.yml`; Caddy + gateway + two services + Postgres,
  built from the one `Dockerfile`): copy `.env.production.example` to `.env.production`, then
  `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
  (`migrate` runs first and the apps wait for it). One-off jobs, run with `run --rm`:
  `ingest` (policy index, needs `OPENAI_API_KEY`) and `seed` (dev-password demo data, never
  automatic). Probes on all three apps: `GET /health` (process, public) and `GET /ready` (database, answered with 404 by Caddy and used by the container healthchecks);
  internal services bind `127.0.0.1` unless `HOST` is set (compose sets `0.0.0.0`)
- AWS (single EC2 instance, region `us-east-1`; runbook `docs/deploy.md`): add the overlay
  `-f docker-compose.aws.yml` to send logs to CloudWatch (`LOG_REGION`, `LOG_GROUP`);
  `deploy/bootstrap.sh` sets up the host, `deploy/backup.sh` + `deploy/orderops-backup.timer`
  take the nightly `pg_dump` to S3 (`deploy/backup.env`, git-ignored). The instance IAM role is the
  only AWS credential: no access keys on the host. Creating or changing AWS or Cloudflare
  resources always needs the user's explicit yes per command group
- Traces: every chat request writes a `ChatTrace` with one `LlmCall` per model
  call (provider, model, tokens, cached tokens, latency, estimated USD cost from
  `models/pricing.ts`; metadata only, no message text). `npm run report:traces
  [-- --since 2026-10-01]` prints p50/p95 latency per route, cost per
  conversation, per-model totals and the cached-token share (default: last 7
  days; needs `DATABASE_URL`). System prompts are cached on Anthropic and
  Bedrock via `cacheableSystem`
- Daily budget (optional; production runs with `1.00`): `DAILY_BUDGET_USD` (positive USD; empty = off, as in dev, tests, CI and
  evals; zero, negative or non-numeric fails startup). Before running the agent, `/chat` sums the
  estimated cost of today's traces (`LlmCall.costUsd` since 00:00 UTC; unpriced calls add 0; evals,
  ingest and embeddings are not counted). At or above the cap it answers with a fixed `final`
  (`route: "budget"`, `orderIds: []`, text in `chat/daily-budget.ts`) and a normal `trace`, with no
  model, orders or checkpoint call (the message is not added to the thread); the trace is stored.
  It resets at 00:00 UTC. A failing spend query counts as exceeded (fail closed). Requests already
  running when the cap is crossed finish, so spend can pass the cap by their cost. `budget` is a
  reply route only (the router never returns it) and is accepted by `GET /observability/traces?route=`
- Rate limits (code constants, no env): the gateway allows 30 `POST /chat` per minute per JWT
  `customerId` (`chat/rate-limit.ts`; fixed one-minute window in memory, exact because the gateway
  is one container). It is checked after auth and body validation (401 and 400 do not count) and
  before the stream starts; past it the answer is 429 JSON `{ statusCode: 429, message }` with
  `Retry-After` (seconds), no agent run and no `ChatTrace`. Demo visitors share the seeded
  customers, so the limit is shared too. The console (`web/src/lib/rate-limit.ts`) limits per
  client IP (`x-real-ip`, else the first `x-forwarded-for` entry, else one shared `unknown` key):
  10 per minute for the three login routes together, 10 for `POST /api/chat`, 60 for the refund
  routes together (`/api/refunds/[id]`, `/api/operator/refunds`, approve/reject). Checked first,
  before the body or the gateway; past it: 429 `{ message: "Too many requests. Try again in N
  seconds." }` with `Retry-After`. A gateway 429 on chat becomes the same console 429. Console
  counts live in each server instance's memory (best effort on Vercel); the gateway limit and
  `DAILY_BUDGET_USD` are the caps. The gateway sends no CORS headers (`test/cors.e2e-spec.ts`)
- Langfuse (optional): set both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (one alone fails
  startup; `LANGFUSE_BASE_URL` defaults to `https://cloud.langfuse.com`, EU; use
  `https://us.cloud.langfuse.com` for US projects) to send a per-node span tree for every chat
  request to Langfuse Cloud. Off without keys (dev, tests, CI and evals need none). Spans are
  metadata only: `apps/orderops-agent/src/trace/langfuse-mask.ts` replaces every input and output
  with `"[redacted]"`, keeps only allowlisted run metadata (`langgraph_node`, `langgraph_step`,
  `ls_provider`, `ls_model_name`, `ls_model_type`; never the caller JWT LangChain copies from
  `configurable`), and cuts error messages to the error type. The Langfuse trace id is the
  `ChatTrace.id` (the `trace` SSE event's `id`) without dashes (32 hex); session id = thread id,
  user id = customer id. A Langfuse outage never affects replies or `ChatTrace`; pending spans are
  flushed in the shutdown drain. Production sends spans to the US project (keys and
  `LANGFUSE_BASE_URL` in `.env.production` on the instance, set 2026-10-24). Spans go out over
  OpenTelemetry (`@langfuse/otel`); Langfuse's v3 read API (`/api/public/traces`, removed
  2026-11-16) is not used by the app, so read spans with `GET /api/public/v2/observations?traceId=`
- Evals: `npm run eval -- --provider anthropic|openai|bedrock [--ids a,b] [--category
  normal|out_of_scope|adversarial] [--limit N]` runs `evals/dataset.json` (41 cases: normal,
  out-of-scope, adversarial) through the real agent graph with both model tiers pinned to
  one provider (no failover). Orders, refunds, memory and the checkpointer are in-memory
  fakes with fixed fixtures and a fixed clock, and FAQ retrieval is a keyword search over
  `policies/*.md`, so only the models cost money and need keys (`--provider` is required;
  the matching `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `AWS_REGION` must be set in
  `.env`). Metrics are deterministic: route, tools, trajectory and guardrail pass rates,
  overall and per category. Each run writes `evals/results/<UTC timestamp>-<provider>.json`
  (summary, per-case flags, answers, tokens, estimated cost, dataset hash, git sha); results
  are meant to be committed. Failed cases do not change the exit code, only a runner or
  config error does; a single run is a sample, not proof. `--judge` adds an LLM-as-judge
  answer-quality metric (fixed 3-criterion rubric: relevant, grounded, appropriate) with
  one extra paid call per case; the judge is the `strong` tier of `--judge-provider`
  (default `anthropic`, so `ANTHROPIC_API_KEY` is needed) and its cost is reported as
  `judgeCostUsd`, apart from the agent cost. FAQ answers are not checked for grounding
  (retrieval context is not captured)
- Provider comparison: `npm run eval:compare` prints a markdown table of the latest
  `evals/results/*.json` per provider and writes `evals/COMPARISON.md`; runs on different
  dataset hashes or judges are flagged as not comparable. Needs no keys
- Eval cost cap and regression check: `npm run eval -- --max-cost USD` stops after the
  case that pushes the estimated agent cost past the cap (or when a cost is unknown) and
  marks the result `truncated` with `casesRun`. `npm run eval:regress [-- --tolerance 0.1]`
  compares each provider's newest `evals/results/*.json` with its previous run on the same
  dataset hash, over the shared cases without run errors; exit 1 only when the pass rate
  fell by more than the tolerance (default 0.10), otherwise 0 (also with no baseline). Needs
  no keys
- Eval CI (`.github/workflows/evals.yml`): pull requests run the `deterministic` job (eval
  specs + `eval:regress`, no secrets, no model calls). The `live` job runs on manual dispatch
  or weekly (Mondays 06:00 UTC, defaults: anthropic, 41 cases, `max_cost` 2.00, no judge); it
  needs the repository secrets `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for provider
  openai), runs the evals, `eval:compare` and `eval:regress`, and uploads `evals/results/`
  and `COMPARISON.md` as the `eval-results` artifact. It never commits: download the
  artifact and commit the results by hand
- PR CI (`.github/workflows/ci.yml`, pull requests only, no secrets): `checks` (lint, the three app
  typechecks, `typecheck:spec`, `npm test`), `integration` (pgvector Postgres service container,
  `prisma migrate deploy`, a schema-drift check with `prisma migrate diff --from-config-datasource
  --to-schema prisma/schema.prisma --exit-code` that fails when a schema change has no migration, then
  `npm run test:e2e`) and `docker` (builds the three runtime images and `tools`, no push) and `web` (install, typecheck,
  test and build of the demo console). The eval
  gate is the `deterministic` job in `evals.yml`. The `master` ruleset (a GitHub setting, not part of
  the files) requires a pull request, squash merges only, and the checks `checks`, `integration`,
  `docker (orderops-agent)`, `docker (orders-service)`, `docker (customers-service)`, `docker (tools)`,
  `web` and `deterministic` (the `docker` matrix reports one check per image, never a plain
  `docker`), so changes reach `master` only through a pull request; read it with
  `gh api repos/ArielBailon/order-ops/rules/branches/master`
- CD (`.github/workflows/deploy.yml`, push to `master` + manual dispatch; one job in the protected
  `production` environment, GitHub OIDC to AWS, no keys): builds the three apps and `tools`, pushes
  them to ECR tagged with the commit SHA, runs `deploy/deploy.sh <sha>` on the instance over SSM
  (pull, migrate, `up --wait`, previous-SHA rollback), then `deploy/smoke.sh <url>` (health, login,
  one chat; needs `SMOKE_EMAIL`/`SMOKE_PASSWORD`) and rolls back if it fails. The smoke login is
  created once on the host with `$dc run --rm smoke-user`. Role, ECR repositories and GitHub
  settings: `docs/deploy.md` "Continuous deployment". Rollbacks do not revert migrations
- Lint: `npm run lint` (oxlint over `apps/`, `libs/` and `web/src/`)
- Format: `npm run format` (prettier)
- Typecheck: `npx tsc -p apps/<app>/tsconfig.app.json --noEmit` (the rspack
  build only transpiles, so it does not catch type errors); spec and e2e files:
  `npm run typecheck:spec`
- Test: `npm test` (Vitest, `**/*.spec.ts`)
- E2E test: `npm run test:e2e` (Vitest, `**/*.e2e-spec.ts`)
- Prisma: `npx prisma generate` after schema changes (config in
  `prisma7.config.ts`, client generated to `libs/prisma/src/generated`, imported
  as `@app/prisma`)

No combined Verify command yet; `/ci` owns that.

Browser testing is opt-in. Run `/tests browser` to add a browser harness and
document its exact command as `Browser tests`. This is an API-first project, so
API/SSE output is the usual evidence instead.
