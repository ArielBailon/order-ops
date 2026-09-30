# Fix: Update stale coding standards

**Type:** Fix
**Status:** verified
**Branch:** fix/update-stale-coding-standards
**Fixes:** F-03

## The problem

`blueprint/context/coding-standards.md` still describes three items as open or
wrong that Feature 1 resolved. Agents read this file before changing code and may
follow the wrong path:

- Line 31: TODO about every app defaulting to port 3000. Now the gateway uses 3000
  (`PORT`), orders-service 3001 and customers-service 3002, all read through
  `ConfigService` from their own `env.ts`.
- Line 61: Prisma client output is stated as `generated/prisma`. It is
  `libs/prisma/src/generated`, imported as `@app/prisma`.
- Line 65: TODO about a schema or database per mock service. The decision was one
  shared database and schema.

## The fix

Documentation only, in `blueprint/context/coding-standards.md`:

- Replace the port TODO with the assigned ports and the rule that ports and
  service URLs come from env via `ConfigService`.
- Correct the client output path to `libs/prisma/src/generated` (import as
  `@app/prisma`).
- Replace the schema TODO with the decision: one shared Postgres database and
  Prisma schema for all apps.
- Follow the file's Writing rules: no em dashes, hyphen separators. Change nothing
  else.

## Build steps

- [x] 1. Edit the three passages in `coding-standards.md`.
  **Done when:** the file has no remaining TODO about ports or the schema
  decision, states `libs/prisma/src/generated` and `@app/prisma`, and
  `git diff` touches only those passages.

## Verify

- Read the diff; confirm each statement against `.env.example`, `prisma/schema.prisma`
  and `apps/*/src/env.ts`.
- No code change, so no test run is required.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":1711,"specSha256":"4ea34d88704221c1c1e86eb9167239afbcc0e1a1978b15c2f5ef72793b440001","branch":"refs/heads/fix/update-stale-coding-standards","head":"4394ed320c9d431b2af56a6d171ab474d1f915d6","baseRef":"refs/heads/master","baseCommit":"4394ed320c9d431b2af56a6d171ab474d1f915d6","sourceTree":"7f8713390eb4ad50c6afc7a3425072bce41a1fc6","absentOptional":[]} -->

## Findings

### update-stale-coding-standards/F-03 [P3] closed - Coding standards are stale after this feature

**File:** blueprint/context/coding-standards.md:31
**Found:** 2026-09-27 by /audit independent (scope: current; lens: quality)
**Why it matters:** This feature resolved three items the standards still describe as open or state incorrectly: the port TODO (line 31, services now use 3001/3002 via `ConfigService`), the Prisma client output path (line 61 says `generated/prisma`; it is now `libs/prisma/src/generated`, imported as `@app/prisma`), and the per-service schema TODO (line 65, the spec chose one shared database and schema). Agents read this file before changing code and may follow the wrong path.
**Suggested fix:** Remove the two TODOs, record the one-schema decision, and update the generated client path. Documentation only; no behavior change.
**Resolution:** Standards updated: ports and env, Prisma client path, one shared schema. Fixed in fix/update-stale-coding-standards. Re-reviewed by /audit 2026-09-30: every statement checked against .env.example, apps/*/src/env.ts, main.ts, tsconfig.json alias and prisma/schema.prisma; no new defect.
