# Fix: Deploy image push 403 from provenance attestations

**Type:** Fix
**Status:** verified
**Branch:** fix/deploy-image-push-403-from-provenance-attestations

## The problem

The Deploy workflow for `424e5e5` ([run 40101426928](https://github.com/ArielBailon/order-ops/actions/runs/40101426928)) failed in "Build and push images". Every layer was pushed, then `docker push` stopped with `unexpected status from HEAD request to .../orderops-agent/manifests/sha256:bbcea24b...: 403 Forbidden`.

The GitHub runner's Docker now uses the containerd image store. The log shows `exporting attestation manifest sha256:bbcea24b...`, `exporting manifest list` and `unpacking to ...`. So `docker build` adds a provenance attestation, and `docker push` uploads a manifest list. Before uploading the list it checks the attestation manifest with a `HEAD` request, which ECR allows only with `ecr:BatchGetImage`. The deploy role is push-only on purpose (`docs/deploy.md`, policy at lines 431-435: no `BatchGetImage`), so the push fails. The previous deploy (`77a059b`) passed with the same workflow and role, which points to the runner change, not to the application code. Nothing was deployed: the job failed before the SSM step, and production still runs the previous release.

## The fix

Add `--provenance=false` to both `docker build` commands in `.github/workflows/deploy.yml` (the `tools` and the `runtime` builds). Without the attestation, a single-platform build is exported as one image manifest, as before, so the push needs only the actions the role already has.

Must not break or change:
- The deploy role stays push-only: no IAM or runbook policy change.
- Image tags, the "already in ECR, skipping" check, the deploy/smoke/rollback step, and the instance's pull (its role already has `BatchGetImage` for pulling).
- `ci.yml` builds without pushing, so it is not affected and stays as is.

A short comment on the build lines explains why provenance is off.

## Build steps

- [x] 1. Add `--provenance=false` to the two `docker build` lines in `deploy.yml`, with a one-line comment. Done when: the workflow file is valid YAML; and a local `docker build --provenance=false --target tools` shows the image stored as a single manifest (no attestation manifest in the build output), while the same build without the flag shows `exporting attestation manifest` (only if the local Docker uses the containerd image store; otherwise the contrast is recorded as not reproducible locally); `git diff` touches only `deploy.yml` and this spec.

## Verify

- Local: the build output check above.
- Real proof (after `/complete` and a push, with the owner's approval of the `production` environment): the Deploy run's "Build and push images" step pushes all four images without a 403, the deploy and smoke test pass, and `https://api.arielbailon.dev/health` answers 200 on the new release.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2878,"specSha256":"8d2e803b9ffc4a41dfa676b10d258c17301a60bbe181930531801f4fb63fb036","branch":"refs/heads/fix/deploy-image-push-403-from-provenance-attestations","head":"424e5e50fc3084da602a164f883ccdde6ad85cdb","baseRef":"refs/heads/master","baseCommit":"424e5e50fc3084da602a164f883ccdde6ad85cdb","sourceTree":"c718ee677cbe398ea7a0bfc9422849cd2baecbc1","absentOptional":[]} -->
