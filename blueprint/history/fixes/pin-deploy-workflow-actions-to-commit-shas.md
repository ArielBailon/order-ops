# Fix: Pin deploy workflow actions to commit SHAs

**Type:** Fix
**Status:** verified
**Branch:** fix/pin-deploy-workflow-actions-to-commit-shas
**Fixes:** F-20

## The problem

[deploy.yml](.github/workflows/deploy.yml) uses three actions by mutable tag: `actions/checkout@v4`, `aws-actions/configure-aws-credentials@v4` and `aws-actions/amazon-ecr-login@v2`. A publisher can move a tag to new code. This is the one workflow whose job holds OIDC credentials that can push images and run commands as root on the production host, so a compromised tag would run with them. `ci.yml` and `evals.yml` use the same tag convention but hold no credentials, so they are left alone.

## The fix

Pin each of the three actions in `deploy.yml` to the full 40-character commit SHA that its current tag points to, keeping the human-readable version in a trailing comment, for example `uses: actions/checkout@<sha> # v4`. Pinning to what the tag points to today changes no behavior; it only stops later tag moves.

- Resolve each SHA with a read-only lookup of the public repository's tags (`git ls-remote --tags https://github.com/<owner>/<repo>.git <tag>`). If a tag is annotated, use the peeled commit (the `^{}` line), not the tag object. This is a network read of three public repositories and needs no credentials; record the exact commands and results in the final report.
- Do not add Dependabot or any other update tooling: no current requirement needs it, and it is a new configuration surface. Updating the pins stays a manual edit.

Must not break: the workflow's triggers, permissions, concurrency, environment, step order and every `with:` input. Out of scope: `ci.yml`, `evals.yml`, F-08, F-19, and any AWS or GitHub settings change.

## Build steps

- [x] 1. Pin the three actions. Done when: the file parses as YAML; every `uses:` in `deploy.yml` is `owner/repo@<40 lowercase hex>` followed by a `# vN` comment naming the tag it was resolved from; each SHA equals the lookup result for that tag at the time of the change (shown in the report); `git diff` changes only those three `uses:` lines; and the shell blocks still pass `bash -n`.

## Verify

Local checks above only. Whether GitHub accepts the pinned references is proven by the next Deploy run (a wrong SHA fails at "Set up job" with a clear error), so I will not claim the live behavior until that run is observed. The deploy needs your approval in `production` as usual.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2434,"specSha256":"5f1a96a2c1d17cb9b83872e697201ef3e1bbe39a84541e16a7f37570792fc13a","branch":"refs/heads/fix/pin-deploy-workflow-actions-to-commit-shas","head":"7fabb0fa390ffd0afe77c622b788414146f7a971","baseRef":"refs/heads/master","baseCommit":"7fabb0fa390ffd0afe77c622b788414146f7a971","sourceTree":"0316106ba38d45d327584fce3cd09b429b8f73cd","absentOptional":[]} -->

## Completion note

SHAs resolved on 2026-10-22 with `git ls-remote --tags` (annotated tag peeled to its commit): actions/checkout v4 -> 11d5960a326750d5838078e36cf38b85af677262; aws-actions/configure-aws-credentials v4 -> 7474bc4690e29a8392af63c5b98e7449536d5c3a; aws-actions/amazon-ecr-login v2 -> 03f1aad4c6c7ffd436567f42f9384779290529bd. F-20 stays `fixed` in the findings ledger until `/audit` re-reviews it, and a `fixed` entry is never archived. Whether GitHub accepts the pins is proven only by the next Deploy run. No independent review receipt: project policy is `manual` and none was requested.
