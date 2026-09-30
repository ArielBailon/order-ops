# Fix: Typecheck spec and e2e files

**Type:** Fix
**Status:** verified
**Branch:** fix/typecheck-spec-and-e2e-files
**Fixes:** F-02

## The problem

No spec or e2e file is covered by the documented `tsc` gate. Every app and lib
tsconfig excludes `test` and `**/*spec.ts`, the root tsconfig has `files: []`, and
Vitest does not typecheck. A scratch typecheck showed the only errors are in the
three `app.e2e-spec.ts` files: `import { App } from 'supertest/types'` does not
resolve under `nodenext` (TS2307), and only works because esbuild drops the
type-only import. Files: `apps/customers-service/test/app.e2e-spec.ts:5`,
`apps/orderops-agent/test/app.e2e-spec.ts:4`, `apps/orders-service/test/app.e2e-spec.ts:5`.

## The fix

- Change the three imports to `import type { App } from 'supertest/types.js'`.
- Add one root `tsconfig.spec.json` that extends `tsconfig.json`, includes
  `apps/**/*.ts` and `libs/**/*.ts` (specs and e2e files included), excludes
  `node_modules`, `dist` and `libs/prisma/src/generated`, and sets `noEmit`.
  Root `files: []` must not leave it empty: override `files` or confirm `include`
  takes effect.
- Add an npm script `typecheck:spec` (`tsc -p tsconfig.spec.json`) and list it in
  the Typecheck line of the Commands section in `AGENTS.md`.
- No new dependency; `@types/supertest` is already installed. Fix any other type
  errors that surface only if they are in test files and trivial; report anything
  larger instead of expanding scope.
- Must not break: `npm test`, `npm run test:e2e`, the per-app `tsc` commands and
  the rspack build (which use their own tsconfigs).

## Build steps

- [x] 1. Fix the three imports, add `tsconfig.spec.json` and the `typecheck:spec`
  script, and document it in `AGENTS.md`.
  **Done when:** `npm run typecheck:spec` exits 0, and reverting one import to the
  old form makes it fail with TS2307 (proves the gate covers e2e files).

## Verify

- `npm run typecheck:spec`, then the per-app `npx tsc -p apps/<app>/tsconfig.app.json --noEmit`.
- `npm test`, `npm run test:e2e`, `npm run lint`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2066,"specSha256":"b2e74a6122e3f161d09de86b8a62ef4a5d20c83da1a77d059916aad6b5b23cf7","branch":"refs/heads/fix/typecheck-spec-and-e2e-files","head":"48200cb10bc2ecbfb78fbe4974e3fd24a44d227b","baseRef":"refs/heads/master","baseCommit":"48200cb10bc2ecbfb78fbe4974e3fd24a44d227b","sourceTree":"c2979aa5fc806a59f6dd1e3eb7e1e75f97dd8099","absentOptional":[]} -->

## Findings

### typecheck-spec-and-e2e-files/F-02 [P3] closed - Spec and e2e files are never typechecked

**File:** apps/orders-service/tsconfig.app.json:10
**Found:** 2026-09-27 by /audit independent (scope: current; lens: tests)
**Why it matters:** Every app and lib tsconfig excludes `test` and `**/*spec.ts`, the root tsconfig has `files: []`, and Vitest does not typecheck, so none of the 9 test files is covered by the documented `tsc` gate. A reviewer-side typecheck of all app and lib files (scratch tsconfig extending the root one) shows the only errors are in the three rewritten e2e files: `import { App } from 'supertest/types'` does not resolve under `nodenext` (TS2307 at apps/customers-service/test/app.e2e-spec.ts:5, apps/orderops-agent/test/app.e2e-spec.ts:4, apps/orders-service/test/app.e2e-spec.ts:5). It runs only because esbuild drops the type-only import. The import was inherited from the scaffold but kept in this delta.
**Suggested fix:** Change the three imports to `import type { App } from 'supertest/types.js'` (or drop the generic), and add a test typecheck (for example a `tsconfig.spec.json` including spec files, run alongside the per-app `tsc` commands in AGENTS.md). No current requirement is lost.
**Resolution:** Imports fixed to import type from supertest/types.js; tsconfig.spec.json and npm run typecheck:spec now cover spec and e2e files (documented in AGENTS.md). Fixed in fix/typecheck-spec-and-e2e-files. Re-reviewed by /audit 2026-09-30: the three imports resolve, tsconfig.spec.json covers apps and libs including specs, negative test showed TS2307 on the old import, no config picks the new tsconfig up by accident; no new defect.
