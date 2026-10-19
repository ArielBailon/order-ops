# Feature: AWS infrastructure

**From build-plan:** feature 9b
**Build attempt:** 1
**Branch:** feature/aws-infrastructure

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
- [ ] 4. Provision and verify in the account (approval gated). Check `aws sts get-caller-identity` and that the CLI user can create the needed resources; then, one command group at a time and only after the user approves it, run the runbook steps 1 to 9. Done when, observed and recorded in the review handoff: `aws ec2 describe-security-groups` shows only 80 and 443 inbound from the internet; `aws ec2 describe-instances` shows the instance profile, IMDSv2 required and no key pair; `https://api.arielbailon.dev/health` returns 200 from the public internet with a valid certificate and `/ready` returns 404; every compose service is healthy on the host; the CloudWatch log group has streams for the five services with retention 30 days; the nightly backup ran once by hand and an object exists in the bucket whose `gunzip` output starts with PostgreSQL dump headers; the budget exists; `aws configure list` and the environment on the host show no access keys. If a verification fails, fix the runbook or files in this branch and re-run; do not mark the step done on a partial result.

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
