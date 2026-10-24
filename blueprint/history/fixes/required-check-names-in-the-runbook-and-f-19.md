# Fix: Required check names in the runbook and F-19

**Type:** Fix
**Status:** verified
**Branch:** fix/required-check-names-in-the-runbook-and-f-19

## The problem

The `master` ruleset (id 25785858) requires eight status checks, as `gh api repos/ArielBailon/order-ops/rules/branches/master` shows: `checks`, `integration`, `docker (orderops-agent)`, `docker (orders-service)`, `docker (customers-service)`, `docker (tools)`, `web`, `deterministic`. The `docker` job in `ci.yml` is a matrix, so GitHub reports one check per image and never a plain `docker`. A ruleset that requires `docker` blocks every pull request forever. That happened to PR #5 until the ruleset was corrected on 2026-10-24.

Three places still give the old or incomplete names:

- `docs/deploy.md` step C4 (lines 479-480): "requiring the `ci.yml` checks (`checks`, `integration`, `docker`) and the `deterministic` eval job". It leaves out `web` and names `docker` instead of the four matrix checks, so a ruleset rebuilt from the runbook would block merges again.
- The F-19 entry in `blueprint/context/findings.md`: its "Fix applied" note lists `docker` as a required check.
- The PR CI bullet in `AGENTS.md` (around line 503): it still says requiring the checks "is a GitHub repository setting (branch protection or a ruleset), not part of the files", with no word that the ruleset now exists or how work reaches `master`.

## The fix

Documentation only:

- `docs/deploy.md` C4: name the eight exact check names, explain in one sentence that the `docker` matrix reports one check per image (`docker (<image>)`) and that a plain `docker` would block every pull request, and add the `gh api` read command that lists what the ruleset requires.
- F-19: correct the list of required checks in its "Fix applied" note. Its status stays `fixed` (closing it is `/audit`'s job).
- `AGENTS.md` PR CI bullet: say the `master` ruleset requires a pull request (squash) and the eight checks by name, so changes reach `master` only through a pull request.

Must not change: the ruleset itself, any workflow file, application code, or any other finding.

## Build steps

- [x] 1. Update the three passages. Done when: `grep` finds no backticked bare `docker` used as a required check name in `docs/deploy.md`, `AGENTS.md` or the findings ledger; the eight names in C4 and `AGENTS.md` match `gh api repos/ArielBailon/order-ops/rules/branches/master` exactly; `git diff` touches only those three files and this spec.

## Verify

- Result (2026-10-24): all eight live check names appear in `docs/deploy.md`, `AGENTS.md` and the F-19 "Fix applied" note; the only remaining bare `docker` mentions are the warning that a plain `docker` is never reported, and F-19's original **Suggested fix** line from 2026-10-22, left as the finding's historical record (its correction is in the Fix applied note).

- The grep and `gh api` comparison above.
- The pull request's required checks pass. The change is documentation only, so the CI jobs run against unchanged code. It needs no deploy: `blueprint/**`, `docs/**` and `**.md` are all in `deploy.yml`'s `paths-ignore`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3115,"specSha256":"c5286ee8614fd84700cb811d9f803727c9c1baae91f4267a071ed067883a58a6","branch":"refs/heads/fix/required-check-names-in-the-runbook-and-f-19","head":"debc3c9a916edd70e3593504d8f1a255fd3a62d8","baseRef":"refs/heads/master","baseCommit":"debc3c9a916edd70e3593504d8f1a255fd3a62d8","sourceTree":"c5e78d943a32de7c98e118121ced007bfa241210","absentOptional":[]} -->
