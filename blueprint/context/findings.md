# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-01 [P2] open - `.env.production` (all production secrets) is not git-ignored

**File:** .gitignore:42
**Found:** 2026-10-19 by /audit independent (scope: current; lens: security)
**Why it matters:** The README and AGENTS.md tell the operator to copy `.env.production.example` to `.env.production` and fill in JWT_SECRET, POSTGRES_PASSWORD and both LLM API keys. `.gitignore` ignores `.env`, `.env.production.local` and others, but not `.env.production`, so `git add .` or `git add -A` would stage the real secrets. `.dockerignore` already excludes `.env.*`, so images are safe; only the Git side is open. The spec states "Secrets live only in the compose env file on the host".
**Suggested fix:** Add `.env.production` (or `.env.*` with `!.env.production.example` and `!.env.example`) to `.gitignore`. Nothing lost.
**Resolution:**

### F-02 [P3] unverified - Prisma disconnects before the SSE shutdown hook runs

**File:** apps/orderops-agent/src/chat/sse-connections.ts:21
**Found:** 2026-10-19 by /audit independent (scope: current; lens: quality)
**Why it matters:** Nest runs `onModuleDestroy` (PrismaService `$disconnect`) before `beforeApplicationShutdown`. In-flight turns therefore lose the database before they are aborted and told `shutting_down`. The aborted-turn trace write (chat.service.ts `finally`) is best-effort and only warns, so the visible effect is probably a lost trace or a warning, but a turn mid-refund-persist could fail. Not confirmed at runtime; the container proof only shows exit 143.
**Suggested fix:** Move the stream close to `onModuleDestroy` of a module that is destroyed before PrismaModule, or to `beforeApplicationShutdown` with a short drain, and add a test of the order. Needs confirmation first.
**Resolution:**

### F-03 [P3] open - Unauthenticated `/ready` is public through Caddy and queries the database per request

**File:** libs/prisma/src/health.controller.ts:23
**Found:** 2026-10-19 by /audit independent (scope: current; lens: security, performance)
**Why it matters:** Caddy proxies every path to the gateway, so `/health` and `/ready` are reachable from the internet. Each `/ready` call runs `SELECT 1`; the timeout race does not cancel the query, so a flood holds pool connections and can starve real requests. Rate limiting is explicitly out of scope (item 11), so this is a known gap, but the probes need not be public. Response bodies reveal nothing beyond up/down.
**Suggested fix:** In the Caddyfile, `respond 404` for `/health` and `/ready` on the public site (compose healthchecks hit the container directly), or accept until item 11. Nothing lost.
**Resolution:**

### F-04 [P3] open - A stream opened after shutdown starts is never notified, and the hook is only tested with fakes

**File:** apps/orderops-agent/src/chat/sse-connections.ts:14
**Found:** 2026-10-19 by /audit independent (scope: current; lens: tests)
**Why it matters:** `track` after `beforeApplicationShutdown` has run (a request on a keep-alive connection during the drain) is added to a set nobody flushes; it holds the server close until the 30s grace period, giving exit 137. The spec covers only streams open before shutdown, and the double `res.end()` in the controller after the hook is untested. The end-to-end stop behavior (exit 143) is proven only by manual commands, as the spec states.
**Suggested fix:** Set a `shuttingDown` flag in the hook and have `track` immediately send the event and end; add a unit test.
**Resolution:**
