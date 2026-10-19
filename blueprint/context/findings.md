# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-03 [P3] open - Unauthenticated `/ready` is public through Caddy and queries the database per request

**File:** libs/prisma/src/health.controller.ts:23
**Found:** 2026-10-19 by /audit independent (scope: current; lens: security, performance)
**Why it matters:** Caddy proxies every path to the gateway, so `/health` and `/ready` are reachable from the internet. Each `/ready` call runs `SELECT 1`; the timeout race does not cancel the query, so a flood holds pool connections and can starve real requests. Rate limiting is explicitly out of scope (item 11), so this is a known gap, but the probes need not be public. Response bodies reveal nothing beyond up/down.
**Suggested fix:** In the Caddyfile, `respond 404` for `/health` and `/ready` on the public site (compose healthchecks hit the container directly), or accept until item 11. Nothing lost.
**Resolution:** `Caddyfile` answers 404 for `/ready` on the public site; `/health` stays public. Proven locally: `/health` 200, `/ready` 404, all services still healthy.
**Reopened:** 2026-10-19 by /audit independent. The matcher `path /ready` is exact, so `GET /ready/` is not matched and is proxied to the gateway, where Express (non-strict routing, Nest default; `main.ts` sets no strict option) serves it as `/ready` and runs `SELECT 1`. The public exposure is therefore only hidden for the canonical path, and README/AGENTS.md state Caddy answers `/ready` with 404. Suggested fix: `@ready path /ready /ready/` (or `/ready*`) and re-prove with `curl -k https://localhost/ready/`. Not verified at runtime (Docker not started in this review).

### F-05 [P3] open - Trace write for a turn aborted by shutdown races with the database disconnect

**File:** apps/orderops-agent/src/chat/sse-connections.ts:21
**Found:** 2026-10-19 by /implement (fix for F-02; scope: current; lens: quality)
**Why it matters:** With the stack stopped mid-stream (`docker compose stop orderops-agent`), the gateway logged `trace write failed: PrismaClientKnownRequestError` for the aborted turn. A plain client disconnect with the database alive logs no such warning, and a normal turn writes its trace. Ending the streams lets the server close at once, so `onApplicationShutdown` disconnects Prisma while the aborted turn is still unwinding and its fire-and-forget `recordTrace` runs. The write is best effort and aborted turns write no refund row, so the effect is one lost trace per interrupted turn, not data corruption.
**Suggested fix:** Have the shutdown hook wait (bounded, for example a few seconds) for the in-flight turns to settle before the server closes, for example by tracking each handler's completion promise next to its response. Needs a small design decision; accept the lost trace until item 10 (observability) if not worth it.
**Resolution:**
