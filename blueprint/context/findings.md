# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-08 [P3] fixed - IMDS hop limit 2 exposes the instance role to every container while Bedrock is off

**File:** docs/deploy.md:204
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: security)
**Why it matters:** `HttpPutResponseHopLimit=2` lets any container, including internet-facing Caddy and the LLM gateway, fetch the role credentials (SSM core, log writes, backup `PutObject`) after an SSRF or container compromise. The doc justifies it only for Bedrock, which is disabled (`AWS_REGION` empty) and unverified. IMDSv2 is still required, so the exposure is modest.
**Suggested fix:** Keep the default hop limit of 1 now and raise it to 2 (`aws ec2 modify-instance-metadata-options`) in the "Bedrock check" step, noting the tradeoff. Nothing is lost today because Bedrock is not in use.
**Resolution:** docs/deploy.md now launches with HttpPutResponseHopLimit=1 (note rewritten) and the "Bedrock check" section raises it to 2 with `aws ec2 modify-instance-metadata-options`, names the credentials-exposure tradeoff and how to set it back to 1. Docs only: the RUNNING instance still has hop limit 2 until the owner runs that command with 1 (a separate, explicit AWS action), and the Bedrock step was not exercised because Bedrock access is suspended.
**Re-review 2026-10-22:** Docs verified (launch command hop limit 1, Bedrock step raises and reverts it). Kept as fixed, not closed: the RUNNING instance still has hop limit 2, so the exposure the finding describes persists until the owner runs the modify-instance-metadata-options command with 1.
**Re-review 2026-10-24:** Live check (`aws ec2 describe-instances`, read-only): instance `i-0f94735086b328aa3` still has `HttpTokens=required`, `HttpPutResponseHopLimit=2`. Kept as fixed. Closes after the owner runs `aws ec2 modify-instance-metadata-options --instance-id i-0f94735086b328aa3 --http-put-response-hop-limit 1 --http-tokens required` and a later audit confirms hop limit 1.
**Applied 2026-10-24 (owner-approved):** `modify-instance-metadata-options` ran; `describe-instances` shows `State=applied`, `HttpTokens=required`, `HttpPutResponseHopLimit=1`, and production stayed healthy (`/health` 200, demo login 200). Kept as fixed until the next audit pass re-examines and closes it.


### F-19 [P3] open - Production deploy approval can be a self-approval; no branch ruleset confirmed

**File:** docs/deploy.md:445
**Found:** 2026-10-22 by /audit (scope: path; lens: security; builder session, not an independent review)
**Why it matters:** The deploy role may run any shell command as root on the instance (`ssm:SendCommand` on `AWS-RunShellScript`), so control of `deploy.yml` on `master` is control of the host and its `.env.production`. The `production` environment requires a reviewer, but the only account is the author and "Prevent self-review" is off, and the branch ruleset (runbook step C4) was optional and is not confirmed to exist. With no ruleset, a direct push to `master` can change the workflow and the author can approve it. This is acceptable for a solo demo; it matters once anyone else has write access.
**Suggested fix:** Confirm the `master` ruleset exists (require a pull request and the `checks`, `integration`, `docker` and `deterministic` checks), and turn on "Prevent self-review" if a second reviewer is ever added. Missing validation: the repository settings were not inspected.
**Resolution:**
**Re-review 2026-10-24 (confirmed, unverified -> open):** Read-only `gh api` checks: `repos/ArielBailon/order-ops/rulesets` returns no rulesets and `branches/master/protection` answers 404 "Branch not protected"; the `production` environment has a `required_reviewers` rule with 1 reviewer and no `prevent_self_review`. Consequence seen today: every change went straight to `master`, so the pull-request-only `ci.yml` and the evals `deterministic` job did not run on 12a-12c or the two deploy fixes (local runs covered lint, typechecks, unit, e2e and web, but not the schema-drift check). Owner decision pending: add the ruleset (changes the workflow to push a branch and open a pull request per item) or accept with a recorded reason (single maintainer).


### F-22 [P2] closed - Trace detail returns model calls in random order, not the call order the spec promises

**File:** apps/orderops-agent/src/observability/observability.store.ts:184
**Found:** 2026-10-22 by /audit independent current (scope: current; lens: quality)
**Why it matters:** The spec's contract (`current-feature.md`, Data / contracts) says `GET /observability/traces/:id` returns `calls` "in call order". `LlmCall` rows are written in one nested create (`trace.store.ts:48`), so they share `createdAt` (Postgres `now()` is the transaction start), and the tiebreak is `id asc` on a random UUID. The order is therefore stable but arbitrary: a cheap routing call can appear after the strong answer call. The code comment and the new AGENTS.md bullet admit this, but the verified spec was not changed, so the contract and the code disagree. Low impact today (metadata only), but the 11a timeline panel would consume this order.
**Suggested fix:** Either amend the spec contract to "stable order, not call order" (matching AGENTS.md), or keep call order by adding an `index`/`seq` integer to `LlmCall` (hand-written migration) set from the array position in `trace.store.ts` and order by it. Nothing current is lost by the spec-only change.
**Resolution:** Feature 11c, step 1: `LlmCall.seq` (migration 20261023120000_llm_call_seq, default 0) is set from each call's position when the trace is stored, and trace detail orders by seq, createdAt, id. New traces list calls in call order; traces stored before the migration keep the old arbitrary order. Specs: trace.store.spec.ts (seq by index), observability.store.spec.ts (order clause). Awaiting re-review.
**Re-review 2026-10-24 (closed):** Re-examined `trace.store.ts:48-55` (seq from the array index inside the one nested create), `observability.store.ts:185-189` (orders by seq, createdAt, id), the migration (`INTEGER NOT NULL DEFAULT 0`) and `trace-recorder.ts` (calls pushed in `handleLLMEnd`, failed calls not recorded). The array is completion order; that equals call order because the graph is strictly sequential (router -> route -> remember -> compact, no parallel nodes or concurrent model calls in `agent.graph.ts`). Specs pass (`vitest run` trace + observability). Pre-migration traces keep the documented stable-but-arbitrary order. No new defect found.
