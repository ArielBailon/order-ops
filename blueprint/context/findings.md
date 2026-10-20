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

**File:** docs/deploy.md:183
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: security)
**Why it matters:** `HttpPutResponseHopLimit=2` lets any container, including internet-facing Caddy and the LLM gateway, fetch the role credentials (SSM core, log writes, backup `PutObject`) after an SSRF or container compromise. The doc justifies it only for Bedrock, which is disabled (`AWS_REGION` empty) and unverified. IMDSv2 is still required, so the exposure is modest.
**Suggested fix:** Keep the default hop limit of 1 now and raise it to 2 (`aws ec2 modify-instance-metadata-options`) in the "Bedrock check" step, noting the tradeoff. Nothing is lost today because Bedrock is not in use.
**Resolution:**


### F-15 [P3] open - Restore failure note assumes the chain only stops at the restore line

**File:** docs/deploy.md:404
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** The note says that if the chain stops "after the drop" the database is empty and to rerun only the restore line, never `up -d`. That is wrong for two other stops. (1) DROP fails (for example a prepared transaction or replication slot blocks `WITH (FORCE)`): the apps are stopped but the live database is intact, not empty; rerunning the restore line fails "already exists" and rolls back (no data loss), and the "repeat DROP" fallback fails again for the same reason. (2) `up -d` fails after a successful restore (build or health problem): the database is fully restored, and the note's advice (rerun the restore line, then DROP/CREATE and restore again) is needless and destructive; the right action is to fix the cause and rerun `$dc up -d`. `rm /tmp/restore.sql.gz` is also skipped, leaving a full customer dump in /tmp. The dump stays in S3, so nothing is lost beyond time.
**Suggested fix:** Replace the note with one line per stop point: stopped at `stop` or DROP (data intact, apps down: fix, rerun the block); stopped at the restore (database empty, rerun only the restore line); stopped at `up -d` (data restored, only fix and rerun `$dc up -d`, then `rm /tmp/restore.sql.gz`). Nothing is lost.
**Resolution:**


### F-16 [P3] open - A stale /tmp/restore.sql.gz passes the download check after a failed download

**File:** docs/deploy.md:375
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** `curl -f -o` writes nothing on an HTTP error, so if an earlier file is still in /tmp (it is removed only after a fully successful restore), `gzip -t` passes and "download ok" prints although the new download failed; the block then restores the older file, possibly a different backup than the one just chosen. Reachable only on a retry after a failed run, hence P3.
**Suggested fix:** Add `rm -f /tmp/restore.sql.gz` before the `curl` line. Nothing is lost.
**Resolution:**
