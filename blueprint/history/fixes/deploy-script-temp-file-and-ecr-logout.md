# Fix: Deploy script temp file and ECR logout

**Type:** Fix
**Status:** verified
**Branch:** fix/deploy-script-temp-file-and-ecr-logout
**Fixes:** F-17, F-18

## The problem

Two small hardening gaps in the CD deploy path, both found by the security audit of 9d:

- **F-17** ([deploy.yml:82](.github/workflows/deploy.yml#L82)): the SSM command copies `deploy/deploy.sh` to the fixed path `/tmp/orderops-deploy.sh` and runs it from there. `/tmp` is world-writable, so a local user on the host who pre-creates or swaps that file gets code run as `ec2-user` (in the `docker` group, so effectively root). It needs a foothold on the host first. The manual rollback snippet in `docs/deploy.md` ("First CD deploy and rollbacks") uses the same fixed path.
- **F-18** ([deploy.sh:54](deploy/deploy.sh#L54)): `docker login` stores the 12-hour ECR pull token unencrypted in `/home/ec2-user/.docker/config.json`, and nothing removes it after the pull.

## The fix

Root-cause repairs only, no new machinery:

- **F-17:** in the remote command (workflow) and in the docs snippet, copy the script to a private file from `mktemp` (mode 0600, unpredictable name), run it from there and remove it afterwards, keeping the script's exit code: `f=$(mktemp) && cp deploy/deploy.sh "$f" && APP_DIR=$PWD AWS_REGION=... bash "$f" <sha> <flag>; rc=$?; rm -f "$f"; exit $rc`. Still a copy, because the checkout of another commit rewrites `deploy/` under a running script.
- **F-18:** in `deploy.sh`, right after the login succeeds, set `trap 'docker logout <registry host> >/dev/null 2>&1 || true' EXIT` so the token is removed on success, on a failed pull, on a failed `up` and on rollback. A logout failure never changes the exit code.

Must not break: the `PREVIOUS_TAG=` first line of output, exit codes (0 deployed, 1 failed, 2 usage), the pull-failure-changes-nothing behavior, rollback, and `APP_DIR`/`AWS_REGION` handling. Out of scope: F-19, F-20, F-08, F-15, F-16, and any change to the AWS resources.

## Build steps

- [x] 1. `deploy.sh` logout (F-18). Add the `EXIT` trap after the `docker login`. Done when: `bash -n deploy/deploy.sh` passes and the stubbed-command harness (docker, git, aws stubs on `PATH`, no real Docker or AWS) shows `docker logout` called exactly once for each of: success, failed pull, failed `up` with rollback, `--no-rollback`, and not called for a malformed SHA (exit 2 before login); exit codes and the `PREVIOUS_TAG=` line are unchanged from before.
- [x] 2. Private temp file (F-17). Change the remote command in `.github/workflows/deploy.yml` and the manual snippet in `docs/deploy.md` to the `mktemp` pattern above. Done when: the workflow parses as YAML and `bash -n` passes on its shell blocks; a local simulation of the exact command string (a fake `deploy.sh` that prints its path, mode and arguments and exits with a chosen code) shows a mode-0600 file under `mktemp`, the arguments `<sha> <flag>` and `AWS_REGION` passed through, the file removed afterwards, and the script's exit code returned for both 0 and 1; `grep` finds no remaining `/tmp/orderops-deploy.sh` in the repository.

## Verify

Both steps run locally as above. The workflow's real SSM command is only proven by the next deploy: after merging, approve the run and check that it succeeds, then look on the instance for no leftover `/tmp/tmp.*` copy and no `auth` entry for the ECR host in `~/.docker/config.json`. I will not claim the live behavior until that deploy is observed.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3472,"specSha256":"8f22b62a86890610f2f459c93f76a5d7e519927472938edfaa9e4f78e2a2a29d","branch":"refs/heads/fix/deploy-script-temp-file-and-ecr-logout","head":"5bccdddb5204038d2d859b000ac0add774418c32","baseRef":"refs/heads/master","baseCommit":"5bccdddb5204038d2d859b000ac0add774418c32","sourceTree":"5eb06c82e23404771bb971df66f4556acc302cf6","absentOptional":[]} -->

## Completion note

F-17 and F-18 stay `fixed` in the findings ledger: they are repaired but not yet re-reviewed by `/audit`, and a `fixed` entry is never archived. The live behavior of the new SSM command is proven only by the next deploy (see Verify). No independent review receipt: project policy is `manual` and none was requested.
