# Feature: AWS infrastructure

**From build-plan:** feature 9b
**Build attempt:** 1
**Branch:** feature/aws-infrastructure
**Status:** verified

## Goal

Run the production compose from feature 9a on one EC2 instance at `https://api.arielbailon.dev`, with no AWS access keys on the server, logs in CloudWatch, a cost alert, and nightly database backups in S3. The repository gets the host-side files and one runbook (`docs/deploy.md`); the AWS and Cloudflare resources are then created in the user's own account, step by step, with explicit approval for each group of billable commands. CI/CD (ECR, SSM deploy, rollback) stays in 9c.

## In scope

- `docker-compose.aws.yml`: an overlay for `docker-compose.prod.yml` that sends every long-running service's logs to CloudWatch with the `awslogs` driver (log group created in advance, not by Docker).
- `deploy/bootstrap.sh`: one-time host setup for Amazon Linux 2023 (Docker engine and compose plugin, git, swap file, enable Docker on boot).
- `deploy/backup.sh` plus `deploy/orderops-backup.service` and `deploy/orderops-backup.timer`: nightly `pg_dump` of the production database streamed to S3.
- `docs/deploy.md`: the step-by-step runbook (resources, exact CLI commands with explicit region, first deploy, verification, backup test, teardown, cost table).
- Provisioning in the user's account, run from the user's terminal with approval per command group: S3 backup bucket, CloudWatch log group with retention, IAM role and instance profile, security group, EC2 instance, Elastic IP, AWS Budgets alert; the Cloudflare DNS record is a manual dashboard step.
- Short pointers in `README.md` (Deployment section) and the `AGENTS.md` Commands section.

## Out of scope

- GitHub Actions, OIDC, ECR, images tagged by commit, deploy over SSM, automatic rollback (9c). The first deploy is manual: the instance builds the images itself.
- Rate limiting, a cost cap on model calls, demo-data reset, and public demo credentials (item 12). The observability API, console and Langfuse (items 10 and 11).
- Verifying that Bedrock works from the instance. The account's Bedrock access is suspended (AWS Support case open), so the Bedrock IAM policy is written and reviewed but its end-to-end check is recorded as pending, and `AWS_REGION` stays empty on the server.
- Multi-AZ, ALB, ECS or RDS (documented in the project plan as the later scale-up path).

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement all steps in order, one reviewable packet at the end, no per-step approval pauses and no checkpoint commits. Steps 1-3 are repository changes. Step 4 creates billable AWS resources: it never starts without an explicit yes from the user for each command group named in the runbook. `/complete` creates the final feature commit.

## Build steps

- [x] 1. CloudWatch logging overlay. Create `docker-compose.aws.yml` with a shared `x-logging` anchor (`driver: awslogs`, options `awslogs-region: ${LOG_REGION:-us-east-1}`, `awslogs-group: ${LOG_GROUP:-/orderops/prod}`, `awslogs-stream: <service>` set per service, `awslogs-create-group: "false"`) applied to `postgres`, `orders-service`, `customers-service`, `orderops-agent` and `caddy`. Add `LOG_REGION` and `LOG_GROUP` (with defaults) to `.env.production.example`. Done when: `docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file <scratch env> config` succeeds and shows `awslogs` with the right group and a distinct stream on exactly those five services, and the prod file alone is unchanged (`git diff docker-compose.prod.yml` is empty).
- [x] 2. Host scripts. `deploy/bootstrap.sh` (idempotent; installs docker, the compose plugin as a pinned release from the GitHub release URL with its checksum verified, git; creates a 2 GB swap file; enables and starts docker; adds `ec2-user` to the docker group). `deploy/backup.sh` (`set -euo pipefail`; reads `BACKUP_BUCKET` from the environment; runs `docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -U orderops orderops | gzip | aws s3 cp - s3://$BACKUP_BUCKET/orderops/<UTC timestamp>.sql.gz`; fails loudly if the dump is empty). The two systemd units run it nightly at 03:00 UTC with `Persistent=true`, as `ec2-user`, with the repo path and bucket from a `deploy/backup.env` file that is documented but not committed. Done when: `bash -n` passes on both scripts (and `shellcheck` when installed); a local test with a stub `aws` on `PATH` (in the scratchpad, not the repo) against the local production stack proves `backup.sh` produces a gzip stream that contains the `Customer` table definition and exits non-zero when the postgres service is not running; the unit files pass `systemd-analyze verify` when available, otherwise are checked by reading.
- [x] 3. Runbook `docs/deploy.md`. Sections: overview and cost table (instance, EBS, EIP, CloudWatch, S3, Budgets, with the free pieces named); decisions (region `us-east-1`, `t3.small` x86, 30 GB gp3, no SSH key and no port 22: access is SSM Session Manager); numbered CLI steps, each with explicit `--region`, shell variables defined before use, and no access keys anywhere: (1) S3 backup bucket with public access blocked, default encryption and a 14-day lifecycle rule; (2) CloudWatch log group `/orderops/prod` with 30-day retention; (3) IAM role and instance profile from inline JSON: trust for EC2, `AmazonSSMManagedInstanceCore`, `logs:CreateLogStream` and `logs:PutLogEvents` on that log group only, `s3:PutObject` on the backup prefix only, and `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the two inference-profile ARNs and the matching foundation-model ARNs built from `MODEL_IDS.bedrock` in `apps/orderops-agent/src/models/providers.ts` (marked: unverifiable until Bedrock access is restored); (4) security group with inbound 80 and 443 only; (5) Cloudflare A record `api` -> Elastic IP, DNS only (grey cloud), created before the first `up` so the certificate issues; (6) launch Amazon Linux 2023 with IMDSv2 required, the instance profile, the group, `bootstrap.sh` as user data; (7) Elastic IP; (8) first deploy over an SSM session: clone, create `.env.production` by typing secrets on the host (never in the repo or the AWS CLI history), `up -d --build` with both compose files, run `ingest`, enable the backup timer and run it once; (9) AWS Budgets monthly cost budget with an email alert at 80% of a stated amount; (10) verification checklist; (11) wipe demo customers after verification (see Notes) ; (12) teardown, in reverse order. Done when: every placeholder variable in the doc is defined earlier in the doc, there is no literal access key or secret, each billable command group is labeled with what it creates and costs, and a read-through finds no step that requires SSH or a long-lived key. The doc states which commands the assistant may run for the user and which are manual.
- [x] 4. Provision and verify in the account (approval gated). Check `aws sts get-caller-identity` and that the CLI user can create the needed resources; then, one command group at a time and only after the user approves it, run the runbook steps 1 to 9. Done when, observed and recorded in the review handoff: `aws ec2 describe-security-groups` shows only 80 and 443 inbound from the internet; `aws ec2 describe-instances` shows the instance profile, IMDSv2 required and no key pair; `https://api.arielbailon.dev/health` returns 200 from the public internet with a valid certificate and `/ready` returns 404; every compose service is healthy on the host; the CloudWatch log group has streams for the five services with retention 30 days; the nightly backup ran once by hand and an object exists in the bucket whose `gunzip` output starts with PostgreSQL dump headers; the budget exists; `aws configure list` and the environment on the host show no access keys. If a verification fails, fix the runbook or files in this branch and re-run; do not mark the step done on a partial result.
- [x] 5. Repair review findings F-07, F-09 and F-10 in the runbook (docs only; F-08 is deferred because changing the live hop limit needs its own approval and Bedrock is off). F-07: rewrite "Restore a backup" so the dump is downloaded on the operator's machine with their own credentials and streamed into the instance, with the bucket name stated explicitly, and keep the instance role at `s3:PutObject` only. F-09: add a short "Recover the variables" block (look up `$INSTANCE`, `$SG`, `$ALLOC`/`$EIP` by tag or group name, redefine `$BUCKET`, `$REGION`, `$DOMAIN`) used by Verify, Update, Restore and Teardown, and restate the `dc=` definition where the host sections use it. F-10: add a "Check the last backup" step (`systemctl status`, `aws s3 ls` newest object age). Done when: the three sections read correctly in a fresh shell with no variable carried over, no step needs `s3:GetObject` on the instance role, and `git diff` touches only `docs/deploy.md`. Mark F-07, F-09 and F-10 `fixed`; F-08 stays open for the Bedrock check step.
- [x] 6. Repair review findings F-11 and F-12 in the restore recipe (docs only). F-11: stop only the three apps, drop and recreate the `orderops` database, restore with `ON_ERROR_STOP` and `--single-transaction`, then `up -d`; never `down -v`. F-12: read the signed link with `read -rs` and pass it to curl via `-K -`. Done when: `git diff` touches only `docs/deploy.md` and the Restore section is a safe, ordered sequence. F-08 stays open for the Bedrock check step.
- [x] 7. Repair review findings F-13 and F-14 (docs and one comment). F-13: split Restore into a verified-download stage and one `&&`-chained destructive stage, with an accurate failure note. F-14: point the `deploy/backup.sh` header comment to the runbook's Restore section. Done when: `git diff` touches only `docs/deploy.md` and the `deploy/backup.sh` comment, both code blocks pass `bash -n`, and `bash -n deploy/backup.sh` passes. F-08 stays open for the Bedrock check step.

## Files / areas

- New: `docker-compose.aws.yml`, `deploy/bootstrap.sh`, `deploy/backup.sh`, `deploy/orderops-backup.service`, `deploy/orderops-backup.timer`, `docs/deploy.md`.
- Changed: `.env.production.example` (two optional logging variables), `README.md` (Deployment section links the runbook), `AGENTS.md` (Commands entry).
- Untouched: `docker-compose.prod.yml`, `Dockerfile`, `Caddyfile`, application code, Prisma schema, workflows.
- Outside the repo, in the user's accounts: the AWS and Cloudflare resources listed in step 4.

## Data / contracts

- Region `us-east-1` for every resource; every CLI command passes `--region us-east-1` explicitly because the user's CLI default is `sa-east-1`.
- Names: log group `/orderops/prod` (retention 30 days); bucket `orderops-backups-<account id>` (14-day expiry); role and instance profile `orderops-ec2`; security group `orderops-web`; instance tag `Name=orderops-prod`.
- Backups: `s3://<bucket>/orderops/<YYYYMMDDTHHMMSSZ>.sql.gz`, a plain `pg_dump` of the `orderops` database (no custom format), gzip. Restore is documented as `gunzip -c | psql`, not automated.
- No new application environment variables. `LOG_REGION` and `LOG_GROUP` are read only by the compose overlay.
- Network exposure: only ports 80 and 443 from the internet; Postgres and the internal services stay on the compose network (unchanged from 9a). Access for operators is SSM Session Manager.
- Secrets: LLM keys, JWT secret and Postgres password exist only in `/home/ec2-user/.../.env.production` on the host, mode 600; none in the repo, user data, tags or CLI history. The instance role is the only AWS credential on the host.

## Testing

- No application logic changes, so no new Vitest tests; run `npm test`, `npm run lint` and `npm run typecheck:spec` once to confirm nothing regressed.
- Step 1 and 2 checks are the commands in their done-when (compose config merge, shell syntax, stubbed-`aws` backup test against the local production stack, torn down with `down -v`).
- Step 4 evidence is live and is recorded from the actual AWS and public-internet commands. Nothing claims Bedrock works from the instance.

## Notes for the AI

- Never run a command that creates, modifies or deletes AWS or Cloudflare resources without the user's explicit yes for that command group in the current chat; read-only `describe`/`get` calls are fine. Show each group's commands and cost first.
- The CLI user (`suxday`) may lack some IAM or Budgets permissions; if so, stop and tell the user exactly which permission or console step is needed rather than widening anything.
- Public exposure risk: after step 4 the stack is reachable by anyone and the dev seed password is documented in the public README, so seeded customers would let anyone spend the Anthropic and OpenAI keys until item 12 adds limits. The runbook therefore seeds only to verify a real chat request, then removes the demo customers (`TRUNCATE "Customer" CASCADE` through `psql` on the host) and states that 9c's smoke test and item 12 must decide how a login exists. Record this in the review handoff.
- IAM for the `us.` inference profiles must allow the foundation-model ARNs in each region the profile routes to; derive them from AWS documentation at implementation time and mark the policy "not verified end to end" in the doc.
- The compose plugin on Amazon Linux 2023 is not in the default repos: download a pinned release and verify its checksum in `bootstrap.sh` rather than piping an installer into a shell.
- Building the three images on a 2 GB instance is slow and memory hungry; the 2 GB swap file is for that. This is acceptable until 9c moves builds to CI.
- Do not push or merge; the user decides. If the repository is private, the runbook must use a read-only token typed on the host and never stored.

## Open questions

- None blocking. Decided here, reversible only by re-provisioning: region `us-east-1` and instance `t3.small` (x86). The user can ask for a different region or `t4g.small` before step 4; otherwise they stand.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":14054,"specSha256":"3de74190f7edffc700ccf4104c90a4d8e4ad90e4daef0d20920f5f0ac155c0d9","branch":"refs/heads/feature/aws-infrastructure","head":"8299c9733b3f8d6968cdd57a82bb1ed7cb1897eb","baseRef":"refs/heads/master","baseCommit":"36dd298fb4202ae5b8a5403c0a09ae21d859449e","sourceTree":"15ac759893cd2eb261d7270fdeb754f178068a0b","absentOptional":[]} -->

## Findings

### 9b/F-07 [P2] closed - Documented restore cannot work from the instance

**File:** docs/deploy.md:332
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: security)
**Why it matters:** "Restore a backup" runs `aws s3 cp s3://$BUCKET/...` on the instance (it pipes into `$dc exec`), but the instance role only grants `s3:PutObject` on `orderops/*` (docs/deploy.md:111-112), so the download fails with AccessDenied. `$BUCKET` is also defined only in the section 0 shell on the operator's machine, so it is empty on the host. The only documented recovery path fails exactly when it is needed. Least-privilege is correct; the doc is wrong.
**Suggested fix:** Say to download the dump from the operator's machine with the operator's own credentials (`aws s3 cp` there) and stream it into the instance over the SSM session, or temporarily grant `s3:GetObject` for the restore. Define or type the bucket name explicitly in that block.
**Resolution:** docs/deploy.md "Restore a backup" now signs a 15-minute link with the operator's own credentials (`aws s3 presign`) and downloads it on the instance with `curl`; the role stays `s3:PutObject` only and the bucket comes from the operator machine. Verified a presigned GET against the real backup returns 200.

Closed 2026-10-20 by /audit independent current: re-read docs/deploy.md:354-378 against the IAM policy (docs/deploy.md:132-133, `s3:PutObject` only); the instance never calls `s3:GetObject`, the operator presigns with their own credentials, and the bucket is defined by step 0 or "Recover the variables". The original defect is gone. Restore ordering problems found in the same section are tracked separately as F-11 and F-12.


### 9b/F-09 [P3] closed - Runbook later sections depend on shell variables that a new session loses

**File:** docs/deploy.md:363
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** Verify, update, restore and teardown use `$INSTANCE`, `$SG`, `$ALLOC`, `$EIP`, `$WORK` and (on the host) `$dc`, which exist only in the shell that ran the earlier sections. Teardown run from a new terminal expands to empty values (for example `delete-security-group --group-id ""`, `s3 rm "s3://"`), failing noisily or acting on the wrong target. On the instance `$dc` is also undefined in each new SSM session (docs/deploy.md:238, 325, 333).
**Suggested fix:** Add a short "Recover the variables" block (look up by tag `Name=orderops-prod`, group name `orderops-web`, `describe-addresses`) and re-state the `dc=` definition in Updating and Restore.
**Resolution:** Added "Recover the variables" to section 0 (looks up INSTANCE, SG, ALLOC by tag, group name and association, with a stop-if-None check), referenced it from Verify, Restore and Teardown, and restated `cd ~/order-ops` plus the `dc=` line in Updating, Restore and Verify. The lookups ran against the live account and returned real ids.

Closed 2026-10-20 by /audit independent current: "Recover the variables" (docs/deploy.md:66-85) re-derives INSTANCE, SG and ALLOC with a stop-if-None check, tells the reader to repeat the step 0 block (REGION, ACCOUNT, BUCKET, LOG_GROUP, ROLE, DOMAIN), and Verify (298-321), Updating (344-352), Restore (360-372), Check the last backup and Teardown (419-422) all point to it or restate `cd ~/order-ops` and `dc=`. No empty-variable path reaches a wrong target (empty or None ids make the AWS call fail).


### 9b/F-10 [P3] closed - A failing nightly backup is silent

**File:** deploy/orderops-backup.service:12
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: tests)
**Why it matters:** The unit has no failure notification and the runbook only runs the backup once by hand. If the dump, `gzip -t` or upload starts failing (for example after a password change), nothing reports it and the 14-day lifecycle quietly expires the last good dump. The scripts also have no committed test or shellcheck run; their checks (stub `aws` test, `bash -n`) were manual and are not reproducible from the repo.
**Suggested fix:** Add a "check the last backup" step to the runbook (`systemctl status`, `aws s3 ls` age) and optionally an `OnFailure=` unit or CloudWatch alarm later; keep scope small. No current requirement is lost.
**Resolution:** Added a "Check the last backup" section (timer, service status, newest object under a day old, weekly cadence). An OnFailure= alert and committed script tests stay out of scope.

Closed 2026-10-20 by /audit independent current: "Check the last backup" (docs/deploy.md:380-396) is correct (oneshot unit shows status=0/SUCCESS, keys are timestamped so `s3 ls | tail` shows the newest, the lifecycle rule is named). The operator-side `s3 ls` uses the operator credentials, consistent with the PutObject-only role.


### 9b/F-11 [P2] closed - Restore recipe lists the commands before the "empty database" caveat and gives no safe sequence

**File:** docs/deploy.md:367
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** The block at 367-375 pipes a plain `pg_dump` (no `--clean`) into the live database with `psql`. The caveat that it only works into an empty database comes after the commands (377-378) and has no exact sequence: `docker compose up -d` always runs `migrate` first (docker-compose.prod.yml:12-18, 132-137), which creates the tables, so a restore after `down -v` then `up -d` fails with "already exists" errors and duplicate rows; `down -v` also deletes the `caddy-data` volume (certificates, docker-compose.prod.yml:155), risking Let's Encrypt rate limits; `exec -T postgres` needs Postgres running, which `down -v` stopped; and `psql` without `-v ON_ERROR_STOP=1` reports success on a half-applied restore. This is the one recovery path and it is untested.
**Suggested fix:** Put the preparation first with exact commands: stop the apps (`$dc stop orderops-agent orders-service customers-service caddy`), recreate only the database (`$dc exec -T postgres psql -U orderops postgres -c 'DROP DATABASE orderops WITH (FORCE)' -c 'CREATE DATABASE orderops'`), restore with `psql -v ON_ERROR_STOP=1 --single-transaction`, then `$dc up -d` (migrate then sees the history). Do not use `down -v`. Rehearse it once against a throwaway dump.
**Resolution:** docs/deploy.md "Restore a backup" now stops only the three apps, drops and recreates just the orderops database, restores with `-v ON_ERROR_STOP=1 --single-transaction`, then `up -d`; `down -v` is called out as unsafe (certificates, Postgres must stay up) and the failure path is stated. Not rehearsed: Docker is not running on this machine and the live database was not touched.


### 9b/F-12 [P3] closed - The presigned restore link is typed into a shell command and stays in history and the process list

**File:** docs/deploy.md:372
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: security)
**Why it matters:** The link is a bearer secret that grants read of a full database dump (customer data and password hashes) until it expires. Writing it as `curl -fsSL '<the signed link>'` on the instance puts it in `~/.bash_history` and briefly in `ps` output; the doc says to "type it, do not save it" but the suggested command saves it. The 15-minute expiry bounds the exposure, so this is small.
**Suggested fix:** Read it without echo or history: `read -rsp 'link: ' URL; curl -fsSL "$URL" -o /tmp/restore.sql.gz; unset URL`. Nothing is lost.
**Resolution:** The signed link is now read with `read -rs` and passed to curl through `-K -` from the printf builtin, so it is not echoed, stored in history or shown in the process list; the file is checked with `gzip -t` before use.

Closed 2026-10-20 (F-11) by /audit independent current: re-read docs/deploy.md:354-393 against docker-compose.prod.yml. Service names (`orderops-agent`, `orders-service`, `customers-service`, `postgres`) match; `pgvector/pgvector:pg16` supports `DROP DATABASE ... WITH (FORCE)` (PG13+); `POSTGRES_USER=orderops` is the superuser and owner, so `CREATE EXTENSION vector` and ownership statements in the plain dump succeed; separate `-c` options run outside a transaction block so DROP/CREATE DATABASE work; the dump carries `vector`, the checkpoint tables and `_prisma_migrations`, so `up -d` runs `migrate deploy` against the restored history and finds nothing to apply; Postgres and Caddy stay up and `down -v` is excluded. `ON_ERROR_STOP` with `--single-transaction` rolls back a failing restore. The original defect (commands before caveat, no safe sequence) is gone. A different defect in the same sequence (no guard when pasted as a block) is tracked as F-13.

Closed 2026-10-20 (F-12) by /audit independent current: docs/deploy.md:374-376 reads the link with `read -rs` (no echo, not in history), feeds it to curl with the `printf` builtin through `-K -` (not in `ps`), unsets it, and checks the file with `gzip -t`. A link up to a few KB fits the tty line limit. The original defect is gone.


### 9b/F-13 [P2] closed - Restore block drops the database even when the download or restore failed

**File:** docs/deploy.md:375
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** The "On the instance" block is a copy-paste sequence with no `set -e` or `&&`. If the signed link expired (15 minutes) or was mistyped, `curl -f` fails and `gzip -t ... && echo` only prints nothing (line 376), yet the next lines still stop the apps and run `DROP DATABASE orderops WITH (FORCE)` and `CREATE DATABASE` (380-382). The `gunzip` then fails on a missing or bad file and the live data is gone with nothing restored. The same applies if the restore line fails: when pasted whole, `$dc up -d` (385) still runs, `migrate` creates the tables in the empty database, and the closing claim "nothing was restored: the database stays empty ... run the gunzip line again before up -d" is no longer true (a rerun fails with "already exists"). The bucket still holds the dump, so this is recoverable, which keeps it at P2.
**Suggested fix:** Make the destructive part conditional on a verified dump: for example `gzip -t /tmp/restore.sql.gz || { echo "bad download, stop"; false; }` as its own step, and say to run the drop/restore/`up -d` lines one at a time, or chain them with `&&` (`... && DROP/CREATE && gunzip ... && $dc up -d`). Nothing is lost.
**Resolution:** docs/deploy.md Restore is now two stages: download plus `gzip -t` (nothing changed, so a failure costs nothing), then one `&&`-chained destructive block under `set -o pipefail` so the first failure stops the rest. The failure note now says the database is empty and apps stopped, to rerun only the restore line, not `up -d`, and to repeat DROP/CREATE if tables exist. Both blocks pass `bash -n`; not rehearsed (no Docker here).


### 9b/F-14 [P3] closed - backup.sh header still shows the restore one-liner that fails on a migrated database

**File:** deploy/backup.sh:6
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: quality)
**Why it matters:** The comment says `Restore: gunzip -c <file>.sql.gz | docker compose ... exec -T postgres psql -U orderops orderops`. F-11 showed that a plain dump into the existing (migrated) database fails with "already exists" errors, and the runbook now documents a different, safe sequence. Two recipes for the one recovery path will drift, and someone reading only the script follows the broken one.
**Suggested fix:** Replace the comment line with "Restore: see 'Restore a backup' in docs/deploy.md (needs an empty database)."
**Resolution:** deploy/backup.sh header now points to "Restore a backup" in docs/deploy.md and states the dump needs an empty database. Comment only; `bash -n` passes.

Closed 2026-10-20 (F-13) by /audit independent current: re-read docs/deploy.md:362-407 end to end. Stage 1 (372-377) changes nothing, so an expired link (`curl -f` fails) or a truncated file (`gzip -t` fails) costs nothing and the doc says to stop. Stage 2 (387-396) is one `&&` chain: `stop` of the three apps (names match docker-compose.prod.yml), DROP/CREATE through `psql -d postgres` (the last `-c` result sets the exit status, so a DROP blocked by anything also fails CREATE and stops the chain), restore with `ON_ERROR_STOP` and `--single-transaction` (rolls back), `up -d`, `rm`. `pipefail` makes a failing `gunzip` fail the restore; it persisting in an interactive SSM bash is harmless (exit codes only). The original defect (drop after a failed download, `up -d` after a failed restore) is gone. The failure note is not accurate for every stop point: see F-15.

Closed 2026-10-20 (F-14) by /audit independent current: deploy/backup.sh:6-7 now says to follow "Restore a backup" in docs/deploy.md and that the dump needs an empty database; no second recipe remains. `bash -n` passes.


## Independent review

# Independent Review

**Status:** passed
**Target commit:** 8299c9733b3f8d6968cdd57a82bb1ed7cb1897eb
**Base commit:** 36dd298fb4202ae5b8a5403c0a09ae21d859449e
**Base ref:** master
**Spec hash:** 3de74190f7edffc700ccf4104c90a4d8e4ad90e4daef0d20920f5f0ac155c0d9
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-20T14:57:44Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-20T16:00:00Z
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

- `git rev-parse HEAD`, `git merge-base master HEAD`, `sha256sum blueprint/context/current-feature.md`, `git status --porcelain`: pass (HEAD equals Target, merge base equals Base, spec hash matches, only review.md and findings.md differ)
- `git diff --stat` and `git diff <Base>..<Target>` over docker-compose.aws.yml, deploy/*, .env.production.example, .gitattributes, .gitignore, AGENTS.md, README.md: pass (read in full)
- `bash -n deploy/backup.sh deploy/bootstrap.sh`: pass
- Read docs/deploy.md in full and docker-compose.prod.yml, prisma/seed.ts, prisma/schema.prisma for service, table and role names: pass
- No test, lint, build, AWS or network command run (Check not required; no automated test exists for shell scripts or docs)

## Evidence

- Delta 36dd298..8299c97: 13 files; all four lenses covered docker-compose.aws.yml, deploy/*, docs/deploy.md, env example, ignore and attributes files, AGENTS/README pointers.
- Restore section (docs/deploy.md:354-407) traced for expired link, truncated download, DROP blocked, restore mid-way failure, `up -d` failure; service names match docker-compose.prod.yml; `pipefail` persistence in an interactive shell is harmless.
- F-13 and F-14 re-examined against current files and closed; F-08 left open (deferred, needs user approval, Bedrock off).
- No secrets found in the delta (only the documented dev password reference and placeholders).

## Findings

- F-15 [P3] open, F-16 [P3] open (new, restore failure note and stale download file); F-08 [P3] open (deferred); F-13 and F-14 closed. No P0 or P1 finding is open or fixed.

## Remaining risk

- Restore, bootstrap checksums, awslogs overlay and the backup timer were not executed here (read-only review, no Docker or AWS access); the restore recipe has never been rehearsed.
- Bedrock path unverified (account access suspended); F-08 keeps IMDS hop limit 2 until the user approves a live change.
- No automated tests or shellcheck cover deploy/*.sh; only `bash -n` was run.
