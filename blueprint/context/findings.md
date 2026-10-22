# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-06 [P3] fixed - Controller `finally { done() }` and the throw path have no test

**File:** apps/orderops-agent/src/chat/chat.controller.ts:60
**Found:** 2026-10-19 by /audit independent current (scope: current; lens: tests)
**Why it matters:** The drain depends on the controller calling `done()` on every exit, including when `chat.reply` throws. The unit specs call `done()` by hand, and no spec exercises the controller, so removing the `try/finally` would leave all tests green while shutdown silently waits the full 5 s timeout and then loses the trace race again.
**Suggested fix:** Add a small controller or e2e test where `chat.reply` throws or the client aborts, asserting the `done` returned by `track` was invoked (or that `beforeApplicationShutdown` resolves without hitting the timeout).
**Resolution:** Added `apps/orderops-agent/src/chat/chat.controller.spec.ts` (3 cases: normal completion writes then ends then releases; `reply` throws and `done` is still called; client close mid-stream stops writing and releases). Mutation checks: replacing the `try/finally` with a plain `done()` after the loop fails the throw case; commenting out `done()` fails all 3. No production code changed.


### F-08 [P3] open - IMDS hop limit 2 exposes the instance role to every container while Bedrock is off

**File:** docs/deploy.md:204
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: security)
**Why it matters:** `HttpPutResponseHopLimit=2` lets any container, including internet-facing Caddy and the LLM gateway, fetch the role credentials (SSM core, log writes, backup `PutObject`) after an SSRF or container compromise. The doc justifies it only for Bedrock, which is disabled (`AWS_REGION` empty) and unverified. IMDSv2 is still required, so the exposure is modest.
**Suggested fix:** Keep the default hop limit of 1 now and raise it to 2 (`aws ec2 modify-instance-metadata-options`) in the "Bedrock check" step, noting the tradeoff. Nothing is lost today because Bedrock is not in use.
**Resolution:**


### F-15 [P3] fixed - Restore failure note assumes the chain only stops at the restore line

**File:** docs/deploy.md:404
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** The note says that if the chain stops "after the drop" the database is empty and to rerun only the restore line, never `up -d`. That is wrong for two other stops. (1) DROP fails (for example a prepared transaction or replication slot blocks `WITH (FORCE)`): the apps are stopped but the live database is intact, not empty; rerunning the restore line fails "already exists" and rolls back (no data loss), and the "repeat DROP" fallback fails again for the same reason. (2) `up -d` fails after a successful restore (build or health problem): the database is fully restored, and the note's advice (rerun the restore line, then DROP/CREATE and restore again) is needless and destructive; the right action is to fix the cause and rerun `$dc up -d`. `rm /tmp/restore.sql.gz` is also skipped, leaving a full customer dump in /tmp. The dump stays in S3, so nothing is lost beyond time.
**Suggested fix:** Replace the note with one line per stop point: stopped at `stop` or DROP (data intact, apps down: fix, rerun the block); stopped at the restore (database empty, rerun only the restore line); stopped at `up -d` (data restored, only fix and rerun `$dc up -d`, then `rm /tmp/restore.sql.gz`). Nothing is lost.
**Resolution:** The closing note in "Restore a backup" now has one bullet per stop point (stop/DROP: data intact, rerun the block; restore: database empty, rerun only the restore line; up -d: data restored, rerun only `$dc up -d` then rm the dump). Docs only; the destructive block is unchanged (same md5).


### F-16 [P3] fixed - A stale /tmp/restore.sql.gz passes the download check after a failed download

**File:** docs/deploy.md:375
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** `curl -f -o` writes nothing on an HTTP error, so if an earlier file is still in /tmp (it is removed only after a fully successful restore), `gzip -t` passes and "download ok" prints although the new download failed; the block then restores the older file, possibly a different backup than the one just chosen. Reachable only on a retry after a failed run, hence P3.
**Suggested fix:** Add `rm -f /tmp/restore.sql.gz` before the `curl` line. Nothing is lost.
**Resolution:** Added `rm -f /tmp/restore.sql.gz` directly before the curl line in the download block, so a stale file cannot pass the gzip check. Docs only.

### F-17 [P3] fixed - deploy.sh is copied to a predictable /tmp path and executed

**File:** .github/workflows/deploy.yml:82
**Found:** 2026-10-22 by /audit (scope: path; lens: security; builder session, not an independent review)
**Why it matters:** The SSM command does `cp deploy/deploy.sh /tmp/orderops-deploy.sh` and then `bash /tmp/orderops-deploy.sh`. `/tmp` is world-writable and the name is fixed. A local user who pre-creates that file with a permissive mode (or swaps it between the `cp` and the `bash`) gets code run as `ec2-user`, which is in the `docker` group and so effectively root. It needs a foothold on the host first (today only `ec2-user` and `ssm-user` exist), so the exposure is modest.
**Suggested fix:** Copy to a private temp file instead: `f=$(mktemp) && cp deploy/deploy.sh "$f" && ... bash "$f"; rm -f "$f"`. Nothing is lost.
**Resolution:** deploy.yml and the docs rollback snippet now copy deploy.sh to a mktemp file (mode 600 confirmed on Linux), run it and remove it, returning the script exit code; verified by simulating the exact command string. Live behavior is proven only by the next deploy.


### F-18 [P3] fixed - The ECR login token stays on disk after every deploy

**File:** deploy/deploy.sh:54
**Found:** 2026-10-22 by /audit (scope: path; lens: security; builder session, not an independent review)
**Why it matters:** `docker login` stores the ECR token unencrypted in `/home/ec2-user/.docker/config.json` (the host printed the warning during the first deploy). The token is a 12-hour pull-only credential for the four `orderops/*` repositories, readable by `ec2-user`, so the impact is small, but it is a credential left at rest that the deploy does not need after the pull.
**Suggested fix:** Run `docker logout "${account}.dkr.ecr.${region}.amazonaws.com"` after the pull (or set a temporary `DOCKER_CONFIG` directory for the script and remove it on exit). Nothing is lost: each deploy logs in again.
**Resolution:** deploy.sh now runs docker logout through an EXIT trap right after the ECR login; the stubbed harness shows exactly one logout on success, failed pull, rollback and --no-rollback, and none for a rejected SHA. Exit codes unchanged.


### F-19 [P3] unverified - Production deploy approval can be a self-approval; no branch ruleset confirmed

**File:** docs/deploy.md:445
**Found:** 2026-10-22 by /audit (scope: path; lens: security; builder session, not an independent review)
**Why it matters:** The deploy role may run any shell command as root on the instance (`ssm:SendCommand` on `AWS-RunShellScript`), so control of `deploy.yml` on `master` is control of the host and its `.env.production`. The `production` environment requires a reviewer, but the only account is the author and "Prevent self-review" is off, and the branch ruleset (runbook step C4) was optional and is not confirmed to exist. With no ruleset, a direct push to `master` can change the workflow and the author can approve it. This is acceptable for a solo demo; it matters once anyone else has write access.
**Suggested fix:** Confirm the `master` ruleset exists (require a pull request and the `checks`, `integration`, `docker` and `deterministic` checks), and turn on "Prevent self-review" if a second reviewer is ever added. Missing validation: the repository settings were not inspected.
**Resolution:**


### F-20 [P3] fixed - Deploy workflow actions are pinned to mutable major tags

**File:** .github/workflows/deploy.yml:40
**Found:** 2026-10-22 by /audit (scope: path; lens: security; builder session, not an independent review)
**Why it matters:** `actions/checkout@v4`, `aws-actions/configure-aws-credentials@v4` and `aws-actions/amazon-ecr-login@v2` can be moved to new code by their publishers. This job holds OIDC credentials that can push images and run commands on the production host, so a compromised tag would run with them. The same convention is used in `ci.yml` and `evals.yml`, which hold no credentials, so this is the one workflow where it carries weight.
**Suggested fix:** Pin the three actions in `deploy.yml` to full commit SHAs with a version comment, and let Dependabot update them. Nothing is lost.
**Resolution:** The three actions in deploy.yml are pinned to the commit SHAs their tags pointed to on 2026-10-22 (checkout v4 11d5960, configure-aws-credentials v4 7474bc4 via the peeled annotated tag, ecr-login v2 03f1aad), with the version in a trailing comment. ci.yml and evals.yml are unchanged. Whether GitHub accepts the pins is proven only by the next Deploy run.

