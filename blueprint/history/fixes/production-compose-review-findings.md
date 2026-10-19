# Fix: Production compose review findings

**Type:** Fix
**Status:** verified
**Branch:** fix/production-compose-review-findings
**Fixes:** F-01, F-02, F-03, F-04

## The problem

The independent review of feature 9a (archived in `blueprint/history/features/09a-containers-and-production-compose.md`) left four non-blocking findings in `blueprint/context/findings.md`:

- **F-01 (P2):** `.env.production` holds every production secret (README and AGENTS.md tell the operator to create it) but is not in `.gitignore` (lines 41-46 only list `.env`, `.env.production.local` and others). `git add .` would stage it.
- **F-02 (P3, unverified):** Nest runs `onModuleDestroy` before `beforeApplicationShutdown`. `PrismaService.onModuleDestroy` (`libs/prisma/src/prisma.service.ts`) disconnects the database before `SseConnections` has ended the in-flight streams, so an interrupted turn can lose its database (trace write, refund persistence) mid-flight.
- **F-03 (P3):** Caddy proxies every path, so the unauthenticated `/ready` is public and runs `SELECT 1` on each call; the 3 s race does not cancel the query, so a flood can tie up pool connections.
- **F-04 (P3):** `SseConnections.track` called after `beforeApplicationShutdown` has run (a request during the drain) is never notified or ended, so it holds the server close until the 30 s grace period and the container exits 137 instead of 143.

## The fix

Root-cause repairs only, no new machinery:

- F-01: add `.env.production` to `.gitignore`; `.env.production.example` stays tracked.
- F-02: move the disconnect from `onModuleDestroy` to `onApplicationShutdown` in `PrismaService`, which Nest runs after `beforeApplicationShutdown` and after the HTTP server has closed. Confirm the Nest order from the installed `@nestjs/core` before relying on it.
- F-03: in the `Caddyfile`, answer 404 for `/ready` on the public site. Keep `/health` public (no database access, useful for external uptime checks and the 9c smoke test). The compose healthchecks call the containers directly, so they are unaffected.
- F-04: `SseConnections` gets a `shuttingDown` flag set by the hook; `track` after that point sends the same `shutting_down` error event, aborts and ends the response immediately.

Must not break: the `shutting_down` event contract, existing health behavior on the three apps, the container healthchecks, or the e2e/unit suites.

## Build steps

- [x] 1. Ignore the production env file (F-01). Add `.env.production` to `.gitignore` next to the other env entries. Done when: `git check-ignore -v .env.production` matches and `git check-ignore .env.production.example` prints nothing.
- [x] 2. Late-stream and disconnect-order repairs (F-04, F-02). Add the `shuttingDown` handling to `apps/orderops-agent/src/chat/sse-connections.ts` with a unit test (a stream tracked after the hook receives the event and is ended and aborted). Change `PrismaService` to disconnect in `onApplicationShutdown` with a unit test that `$disconnect` runs there and not in `onModuleDestroy`. Done when: `npm test`, `npm run typecheck:spec`, `npm run lint` and the three app typechecks pass, and the Nest lifecycle order is confirmed from `node_modules/@nestjs/core` (cite the file in the review handoff).
- [x] 3. Hide `/ready` from the public site (F-03). Add the 404 matcher to `Caddyfile`; update the README "Production compose" step 5 and the `/health`/`/ready` paragraph, and the probes sentence in the AGENTS.md Commands entry, to say `/ready` is internal (checked by the container healthchecks) and `/health` is public. Done when, with the local stack up (`API_DOMAIN=localhost`, as in the README): `curl -k https://localhost/health` returns 200, `curl -k https://localhost/ready` returns 404, `docker compose ps` still shows every service healthy, and a `docker compose stop orderops-agent` during an open stream still delivers `shutting_down` and exits 143.

## Verify

- `npm test`, `npm run lint`, `npm run typecheck:spec`, `npx tsc -p apps/<app>/tsconfig.app.json --noEmit` for all three apps, and `npx nest build orderops-agent`.
- The step 3 stack proof above, run once with the real `.env` keys in a scratch env file outside the repo; tear the stack down with `down -v` afterwards.
- `blueprint/context/findings.md`: after the fix lands, mark F-01 to F-04 `fixed`; `/audit` re-reviews them before they close.

## Notes

- Fix spec is deliberately small. No new dependency, endpoint, config surface or abstraction.
- Rate limiting for public endpoints stays in build-plan item 12; this fix only stops publishing `/ready`.
- A runtime proof that F-02 is gone (no Prisma errors during a mid-stream stop) is a nice-to-have in step 3; if the logs show database errors after the stop, record it as a new finding rather than widening this fix.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":4785,"specSha256":"c48c943fc617c6c4e02b2203ef9320d3faefcc788ceaab886db6c34133f74835","branch":"refs/heads/fix/production-compose-review-findings","head":"d3be35224ef43bb7be58ffbb2d9654dc6fa94460","baseRef":"refs/heads/master","baseCommit":"73e18b34ba7817622520cc44708ba9b4c9173743","sourceTree":"c466fcdcf5bfc7a73d6de9561b2b1bf73e74c299","absentOptional":[]} -->

## Findings

### production-compose-review-findings/F-01 [P2] closed - `.env.production` (all production secrets) is not git-ignored

**File:** .gitignore:42
**Found:** 2026-10-19 by /audit independent (scope: current; lens: security)
**Why it matters:** The README and AGENTS.md tell the operator to copy `.env.production.example` to `.env.production` and fill in JWT_SECRET, POSTGRES_PASSWORD and both LLM API keys. `.gitignore` ignores `.env`, `.env.production.local` and others, but not `.env.production`, so `git add .` or `git add -A` would stage the real secrets. `.dockerignore` already excludes `.env.*`, so images are safe; only the Git side is open. The spec states "Secrets live only in the compose env file on the host".
**Suggested fix:** Add `.env.production` (or `.env.*` with `!.env.production.example` and `!.env.example`) to `.gitignore`. Nothing lost.
**Resolution:** Added `.env.production` to `.gitignore`; `git check-ignore -v .env.production` matches and `.env.production.example` stays tracked.
**Closed:** 2026-10-19 by /audit independent. `git check-ignore -v .env.production` matches `.gitignore:45`; `.env.production.example` is not ignored.

### production-compose-review-findings/F-02 [P3] closed - Prisma disconnects before the SSE shutdown hook runs

**File:** apps/orderops-agent/src/chat/sse-connections.ts:21
**Found:** 2026-10-19 by /audit independent (scope: current; lens: quality)
**Why it matters:** Nest runs `onModuleDestroy` (PrismaService `$disconnect`) before `beforeApplicationShutdown`. In-flight turns therefore lose the database before they are aborted and told `shutting_down`. The aborted-turn trace write (chat.service.ts `finally`) is best-effort and only warns, so the visible effect is probably a lost trace or a warning, but a turn mid-refund-persist could fail. Not confirmed at runtime; the container proof only shows exit 143.
**Suggested fix:** Move the stream close to `onModuleDestroy` of a module that is destroyed before PrismaModule, or to `beforeApplicationShutdown` with a short drain, and add a test of the order. Needs confirmation first.
**Resolution:** `PrismaService` now disconnects in `onApplicationShutdown`, which Nest runs after `beforeApplicationShutdown` and after the HTTP server closes (order read from `node_modules/@nestjs/core/nest-application-context.js` `runShutdownSequence`). Residual race for the aborted turn's best-effort trace write is recorded as F-05.
**Closed:** 2026-10-19 by /audit independent. `runShutdownSequence` in the installed @nestjs/core runs destroy hook, beforeApplicationShutdown, dispose (HTTP server close), then onApplicationShutdown, so the disconnect now follows the stream abort and server close. `main.ts` calls `enableShutdownHooks()`; no other `onModuleDestroy` remains. The spec only asserts the method placement, not ordering; acceptable.

### production-compose-review-findings/F-04 [P3] closed - A stream opened after shutdown starts is never notified, and the hook is only tested with fakes

**File:** apps/orderops-agent/src/chat/sse-connections.ts:14
**Found:** 2026-10-19 by /audit independent (scope: current; lens: tests)
**Why it matters:** `track` after `beforeApplicationShutdown` has run (a request on a keep-alive connection during the drain) is added to a set nobody flushes; it holds the server close until the 30s grace period, giving exit 137. The spec covers only streams open before shutdown, and the double `res.end()` in the controller after the hook is untested. The end-to-end stop behavior (exit 143) is proven only by manual commands, as the spec states.
**Suggested fix:** Set a `shuttingDown` flag in the hook and have `track` immediately send the event and end; add a unit test.
**Resolution:** `SseConnections` keeps a `shuttingDown` flag; a stream tracked after the hook is aborted, sent `shutting_down` and ended at once (new unit test).
**Closed:** 2026-10-19 by /audit independent. `track` ends the stream when `shuttingDown`; the new spec asserts abort, one `shutting_down` write and `writableEnded`. `npx vitest run apps/orderops-agent/src/chat libs/prisma`: 79 passed. The controller then skips writes on the aborted signal and calls `res.end()` on an ended response, which is a harmless no-op.

## Independent review

**Status:** passed
**Target commit:** d3be35224ef43bb7be58ffbb2d9654dc6fa94460
**Base commit:** 73e18b34ba7817622520cc44708ba9b4c9173743
**Base ref:** refs/heads/master
**Spec hash:** c48c943fc617c6c4e02b2203ef9320d3faefcc788ceaab886db6c34133f74835
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-19T16:19:26Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-19T16:30:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

## Handoff

Review the active spec and the complete `<base>..<target>` delta in a fresh
session or isolated subagent without the builder conversation. Run all Audit lenses from scratch.
Run Check when required above. Do not edit product code, accept findings, or
reuse the existing findings as the review scope.

## Commands

- `git diff 73e18b3..d3be352` (product files): pass
- `git rev-parse HEAD`, `git merge-base master HEAD`, `sha256sum blueprint/context/current-feature.md`: pass (match target, base and spec hash; only findings.md and review.md are dirty)
- `npx vitest run apps/orderops-agent/src/chat libs/prisma`: pass (6 files, 79 tests)
- `npm run lint`: pass (no output)
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit` and `npm run typecheck:spec`: pass
- `git check-ignore -v .env.production` / `.env.production.example`: pass (first ignored, second not)
- Docker, Caddy and dev servers: unavailable by instruction

## Evidence

- `.gitignore:45` ignores `.env.production`; the example file stays tracked (F-01).
- `node_modules/@nestjs/core/nest-application-context.js` `runShutdownSequence`: destroy hook, beforeApplicationShutdown, dispose, onApplicationShutdown; `PrismaService` now uses the last (F-02).
- `Caddyfile` `@ready path /ready` is an exact match, so `/ready/` reaches the gateway (F-03).
- `sse-connections.ts` `shuttingDown` flag and its new spec cover late streams (F-04).
- The four lenses covered all nine changed files in the range; the only blocking threshold is P0/P1 and none exist.

## Findings

- F-01 closed, F-02 closed, F-04 closed
- F-03 open (P3): `/ready/` bypasses the Caddy 404; docs overstate the block
- F-05 open (P3): aborted-turn trace write can race the Prisma disconnect (accepted, recorded)

## Remaining risk

- Caddy behavior, container shutdown ordering and `/ready/` bypass not exercised at runtime (Docker and servers unavailable by instruction).
- A PrismaService spec asserts method placement only, not shutdown ordering end to end.
- No external security or dependency scan was run.
