# Fix: Demo reset recreates Postgres and deploy role docs drift

**Type:** Fix
**Status:** verified
**Branch:** fix/demo-reset-recreates-postgres-and-deploy-role-docs-drift

## The problem

1. **The nightly demo reset restarts the production database.** `deploy/demo-reset.sh` runs `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm demo-reset`. The `demo-reset` job inherits `depends_on: postgres` from the shared `x-tools` block, so compose also starts Postgres. `deploy.sh` runs the stack with the AWS overlay as well (`-f docker-compose.aws.yml`, which sets the CloudWatch `awslogs` driver), so the Postgres config compose computes without the overlay differs from the running container, and compose recreates it. Seen on the first production run (SSM command `2c7bfe5d`): `Container order-ops-postgres-1 Recreate ... Started`. The database restarted for a few seconds (data is safe on the `pgdata` volume, and the API recovered: health and login answer 200), and Postgres now logs locally instead of to CloudWatch. With the timer on, this would repeat every night at 04:00 UTC.
2. **The runbook's deploy role policy is out of date.** The live role `orderops-github-deploy` now also allows `ecr:BatchGetImage` on `repository/orderops/*`. The owner applied this on 2026-10-24 after CloudTrail showed `BatchGetImage` `AccessDenied` on every push, because `docker push` with the containerd image store checks the manifest with a `HEAD` request first. `docs/deploy.md` (the `EcrPush` statement around line 432) still lists the old actions, so a rebuilt role would break deploys again.
3. **The `deploy.yml` comment gives the wrong reason.** It says provenance is off because pushing an attestation list needs `ecr:BatchGetImage`. Turning provenance off did not avoid that call (run `40102162876`, attempt 1, still got a 403 on the plain manifest). Provenance stays off so each image is one plain manifest, but the comment must not claim that it keeps the role free of `BatchGetImage`.

## The fix

- `deploy/demo-reset.sh`: use the same compose files as `deploy/deploy.sh` (`-f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production`) and `run --rm --no-deps demo-reset`. Postgres is already running and healthy on the host, so the job needs no dependency handling. With `--no-deps` it never creates, starts or recreates another service, and the matching files keep its own logs in CloudWatch like every other container. Update the header comment to say so.
- `docs/deploy.md`: add `ecr:BatchGetImage` to the `EcrPush` actions with one sentence on why (`docker push` checks the manifest first; still limited to `repository/orderops/*`). Add a short "if the role predates this" command (`aws iam put-role-policy` with the updated file) next to it, and note in section 11 that the reset leaves the other containers untouched.
- `.github/workflows/deploy.yml`: reword the comment. Provenance is off so each image is one plain manifest (no attestation index in ECR). Pushing needs `ecr:BatchGetImage`, which the role has (link the runbook section).

Must not break or change: the reset's behavior and transaction, the timer and service units, `deploy.sh`, `backup.sh`, the build lines, or any other policy statement. No product code changes.

## Build steps

- [x] 1. Script, runbook and comment as above. Done when:
  - `bash -n deploy/demo-reset.sh` passes;
  - `docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production.example --profile jobs config -q` passes (required variables given dummy values);
  - a local `docker compose ... --dry-run run --rm --no-deps demo-reset` with both files lists no create, start or recreate for `postgres`, while the same dry run without `--no-deps` does (recorded as not reproducible if the dry run cannot evaluate a stack that is not running locally);
  - the policy JSON in `docs/deploy.md` matches the live `EcrPush` actions from a read-only `aws iam get-role-policy`;
  - `git diff` touches only `deploy/demo-reset.sh`, `docs/deploy.md`, `.github/workflows/deploy.yml` and this spec.

## Verify

- Local: the checks above.
- Production (after `/complete` and a push, approved in GitHub): the Deploy run passes, and its `up` recreates Postgres with the overlay again, so CloudWatch logging returns. The next reset (manual via SSM, or the 04:00 UTC timer) prints `Demo reset: ...` with no `Container order-ops-postgres-1 Recreate` line, and `systemctl status orderops-demo-reset.service` shows success.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":4527,"specSha256":"c473f027179ac98d90a69eb092948e0688afa0507a00002d3479e89e9763b499","branch":"refs/heads/fix/demo-reset-recreates-postgres-and-deploy-role-docs-drift","head":"686bd744792caf38f9b22fb68d46b94165351f7f","baseRef":"refs/heads/master","baseCommit":"686bd744792caf38f9b22fb68d46b94165351f7f","sourceTree":"7d1b401bdd94403ca71bc0565eb7f49732531c94","absentOptional":[]} -->
