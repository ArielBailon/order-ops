# Fix: Hide the readiness probe variants from the public site

**Type:** Fix
**Status:** verified
**Branch:** fix/hide-readiness-probe-variants
**Fixes:** F-03

## The problem

F-03 (reopened by the independent review of the previous fix): `Caddyfile` hides `/ready` with `@ready path /ready`, an exact match. `GET /ready/` is not matched, is proxied to the gateway, and Express (Nest default, non-strict routing, case-insensitive) serves it as `/ready` and runs `SELECT 1`. The public exposure is hidden only for the canonical spelling, and README.md (Production compose section) and AGENTS.md (production compose Commands entry) say Caddy answers `/ready` with 404.

## The fix

In `Caddyfile`, widen the matcher so the same 404 covers the trailing-slash and nested variants: `@ready path /ready /ready/*`. Keep `/health` public and `respond` ahead of `reverse_proxy`. No new directive, config surface or abstraction. The container healthchecks hit the apps directly, so they are unaffected.

Must not break: `/health` (200 through Caddy), SSE flushing on `/chat`, login and other routes, the container healthchecks.

## Build steps

- [x] 1. Widen the Caddy matcher (F-03). Edit `@ready` in `Caddyfile`. Done when, with the production compose stack up locally (`API_DOMAIN=localhost`, scratch env file outside the repo, as in the README): `curl -k` returns 404 for `https://localhost/ready`, `/ready/`, `/ready//`, `/ready/x`, `/READY`, `/%72eady` and `/ready?x=1`; `/health` still returns 200; a `POST /chat` still streams events through Caddy; `docker compose ps` shows every service healthy. Tear the stack down with `down -v` afterwards. If a variant still returns 200, widen the matcher or note the limit in the finding; do not claim it is blocked.

## Verify

- The curl matrix above (record each status).
- `npm test`, `npm run lint` unaffected (no code changes); run them once.
- Mark F-03 `fixed`; `/audit` re-reviews before it closes. F-05 stays open and is out of scope here.

## Notes

- Caddyfile and live proof only; README and AGENTS.md already describe the intended behavior, so change them only if a variant cannot be blocked.
- Rate limiting stays in build-plan item 12.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2192,"specSha256":"bec0807f9efc68ebee6a12423146a37378edaa7c50702adbb8f6f6c480dbba8e","branch":"refs/heads/fix/hide-readiness-probe-variants","head":"73ae6bc579dc2b49b4507d86784102c6be74432f","baseRef":"refs/heads/master","baseCommit":"ec2dc40574ad1db7db7fda40837825489c6943f9","sourceTree":"96791e4700bfb92c83b6a09f3cdc6882deb0bf76","absentOptional":[]} -->

## Findings

### hide-readiness-probe-variants/F-03 [P3] closed - Unauthenticated `/ready` is public through Caddy and queries the database per request

**File:** libs/prisma/src/health.controller.ts:23
**Found:** 2026-10-19 by /audit independent (scope: current; lens: security, performance)
**Why it matters:** Caddy proxies every path to the gateway, so `/health` and `/ready` are reachable from the internet. Each `/ready` call runs `SELECT 1`; the timeout race does not cancel the query, so a flood holds pool connections and can starve real requests. Rate limiting is explicitly out of scope (item 11), so this is a known gap, but the probes need not be public. Response bodies reveal nothing beyond up/down.
**Suggested fix:** In the Caddyfile, `respond 404` for `/health` and `/ready` on the public site (compose healthchecks hit the container directly), or accept until item 11. Nothing lost.
**Resolution:** `Caddyfile` answers 404 for `/ready` on the public site; `/health` stays public. Proven locally: `/health` 200, `/ready` 404, all services still healthy.
**Re-fixed:** 2026-10-19 by /implement. Matcher widened to `@ready path /ready /ready/*`. Before the change the same stack returned 200 for `/ready/`; after it `/ready`, `/ready/`, `/ready//`, `/ready/x`, `/READY`, `/%72eady` and `/ready?x=1` all return 404, `/health` returns 200, a `POST /chat` streams to `final`, and every service stays healthy.
**Reopened:** 2026-10-19 by /audit independent. The matcher `path /ready` is exact, so `GET /ready/` is not matched and is proxied to the gateway, where Express (non-strict routing, Nest default; `main.ts` sets no strict option) serves it as `/ready` and runs `SELECT 1`. The public exposure is therefore only hidden for the canonical path, and README/AGENTS.md state Caddy answers `/ready` with 404. Suggested fix: `@ready path /ready /ready/` (or `/ready*`) and re-prove with `curl -k https://localhost/ready/`. Not verified at runtime (Docker not started in this review).
**Closed:** 2026-10-19 by /audit independent (fresh subagent, claude-sonnet-5-5). `Caddyfile` now has `@ready path /ready /ready/*` ahead of `reverse_proxy`. Caddy's `path` matcher is case-insensitive, matches the percent-decoded path and merges duplicate slashes, so `/READY`, `/%72eady` and `/ready//` are covered; `/ready/` and `/ready/x` match the `/ready/*` glob; the query string is not part of the path. Express (non-strict, case-insensitive) only routes `/ready` and `/ready/` to the handler, both blocked; other spellings (`//ready`, encoded slashes) do not route to it. The recorded curl matrix (all 404, `/health` 200, `/chat` streams) agrees. Not re-run in this review (Docker unavailable).

## Independent review

**Status:** passed
**Target commit:** 73ae6bc579dc2b49b4507d86784102c6be74432f
**Base commit:** ec2dc40574ad1db7db7fda40837825489c6943f9
**Base ref:** refs/heads/master
**Spec hash:** bec0807f9efc68ebee6a12423146a37378edaa7c50702adbb8f6f6c480dbba8e
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-19T16:32:39Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-19T16:34:00Z
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

- `git diff ec2dc40..73ae6bc` (Caddyfile and spec only): pass
- `git rev-parse HEAD`, `git merge-base refs/heads/master HEAD`, `sha256sum current-feature.md`, `git status --short`: pass (match request; only the two evidence files differ)
- Docker, curl matrix, `npm test`, `npm run lint`: unavailable (not run in this review)

## Evidence

- `Caddyfile:6` `@ready path /ready /ready/*` followed by `respond @ready 404`, before `reverse_proxy`; `/health` untouched. The only product change in the delta.
- Caddy path matcher semantics (case-insensitive, percent-decoded, duplicate slashes merged, query excluded) cover `/READY`, `/%72eady`, `/ready//`, `/ready?x=1`; the glob covers `/ready/` and `/ready/x`.
- Express non-strict routing reaches the handler only via `/ready` or `/ready/` (case-insensitive); both blocked. Recorded live matrix in findings F-03 (Re-fixed) shows 404 for all variants and 200 for `/health`.
- Performance: no new cost; blocked requests answered by Caddy before the database. Tests: config-only change, no unit test applicable; proof is the recorded live matrix.

## Findings

- F-03 closed. No new findings. F-05 (P3, open) unchanged.

## Remaining risk

- Not run: Docker, the live curl matrix, `npm test`, `npm run lint`; the verdict relies on the config, Caddy documentation knowledge and the builder-recorded evidence.
- Caddy version is not pinned in this review; matcher normalization behaviour was assumed from Caddy 2.x.
- Rate limiting on public endpoints remains build-plan scope.
