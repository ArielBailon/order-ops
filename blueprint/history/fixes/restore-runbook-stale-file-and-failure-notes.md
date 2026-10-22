# Fix: Restore runbook stale file and failure notes

**Type:** Fix
**Status:** verified
**Branch:** fix/restore-runbook-stale-file-and-failure-notes
**Fixes:** F-15, F-16

## The problem

Two accuracy gaps in the "Restore a backup" section of [docs/deploy.md](docs/deploy.md#L495), found by an earlier independent audit. Both are documentation only; the restore commands themselves are correct.

- **F-16:** the download block runs `curl -fsS -K - -o /tmp/restore.sql.gz` and then `gzip -t`. `curl -f` writes nothing on an HTTP error, so if an older `/tmp/restore.sql.gz` is still there (it is removed only after a fully successful restore), `gzip -t` passes and `download ok` prints although the new download failed. The block then restores the older dump, possibly a different backup than the one just chosen.
- **F-15:** the closing note says that if the chain "stops after the drop" the database is empty and only the restore line should be rerun. That is wrong for two other stops: if `stop` or `DROP` fails the live database is intact (apps down, nothing lost), and if `up -d` fails after a successful restore the database is fully restored and the advice (rerun the restore, DROP/CREATE again) is needless and destructive. It also skips the `rm`, leaving a full customer dump in `/tmp`.

## The fix

Edit only the restore section of `docs/deploy.md`:

- **F-16:** add `rm -f /tmp/restore.sql.gz` on the line before the `curl` line, with a short comment saying a stale file from an earlier run must not pass the `gzip -t` check.
- **F-15:** replace the closing "If the chain stops after the drop" paragraph with one line per stop point, keeping the existing reasons (a rerun of `up -d` before the restore would let `migrate` create empty tables):
  - stopped at `stop` or `DROP`: the database is intact and the apps are down; fix the cause and rerun the whole block.
  - stopped at the restore: the failed single transaction rolled back, so the database is empty and the apps are stopped; fix the cause and rerun only the restore line, not `up -d`; if tables already exist, repeat the `DROP DATABASE` and `CREATE DATABASE` line first.
  - stopped at `up -d`: the data is restored; fix the cause (build or health) and rerun only `$dc up -d`, then `rm /tmp/restore.sql.gz`.
  - the dump stays in S3 in every case.

Must not break: the destructive block's chaining and `set -o pipefail`, the `ON_ERROR_STOP`/`--single-transaction` explanation, and the `down -v` warning. Out of scope: F-08, F-20, F-19, any code, any AWS change.

## Build steps

- [x] 1. F-16: add the `rm -f` line and comment before the `curl`. Done when: `grep -n "rm -f /tmp/restore.sql.gz" docs/deploy.md` shows it directly before the `curl` line inside the download block, the final `&& rm /tmp/restore.sql.gz` in the destructive block is unchanged, and the download code block passes `bash -n`.
- [x] 2. F-15: replace the closing paragraph with the per-stop-point guidance above. Done when: the section names all three stop points with the right state of the database and the right next action, still says the dump stays in S3, the destructive code block is byte-identical to before (`git diff` shows changes only in prose and the one new line from step 1), and its code blocks pass `bash -n`.

## Verify

Docs only, so nothing runs in production. Read the diff against the two findings: every `Suggested fix` point is present, no command in the destructive block changed, and the section still reads in order (download, check, destructive block, per-stop notes). I will not claim the restore procedure was exercised; no restore is run.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3613,"specSha256":"32953000e6044f5fa11230ea433902f0e224f3febbf1906da95d527ed265f00b","branch":"refs/heads/fix/restore-runbook-stale-file-and-failure-notes","head":"3cddef499c0e3e50ae46ed2b869721fc7740c4ae","baseRef":"refs/heads/master","baseCommit":"3cddef499c0e3e50ae46ed2b869721fc7740c4ae","sourceTree":"7d29eb778b729ee8ede0a506046092f2cfc30b04","absentOptional":[]} -->

## Completion note

F-15 and F-16 stay `fixed` in the findings ledger: they are repaired but not yet re-reviewed by `/audit`, and a `fixed` entry is never archived. Documentation only; no restore was run, so the procedure itself was not exercised. No independent review receipt: project policy is `manual` and none was requested.
