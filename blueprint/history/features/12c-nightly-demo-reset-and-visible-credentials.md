# Feature: Nightly demo reset and visible credentials

**From build-plan:** feature 12c
**Build attempt:** 1
**Branch:** feature/nightly-demo-reset-and-visible-credentials
**Status:** verified

## Goal

Keep the public demo usable and clean. A reset job restores the seeded demo accounts and orders and clears what visitors leave behind (refund requests, chat threads, remembered facts). It runs every night on the host, and its first run brings the demo customers back to production (section 11 of the runbook deleted them). The console's login screen shows the demo credentials. Per the owner's decisions: the screen shows the customer emails plus the shared demo password, which also works against the public API. Production uses the already published dev password (no new secret). Order dates are stored as offsets from the reset moment, so every night one delivered order is inside the 30-day refund window (reaching the operator) and one is outside it (auto-rejected).

## In scope

- **Relative seed dates**: move the demo customers and orders out of `prisma/seed.ts` into `prisma/demo-data.ts`, with order dates as day offsets from a `now` argument. Statuses, ids, items and totals stay as today. Offsets (days before `now`; `createdAt` / `shippedAt` / `deliveredAt`):
  - `ORD-1001` Ana, delivered: 9 / 8 / 5 (inside the window: refundable, goes to the operator)
  - `ORD-1002` Ana, shipped: 6 / 4 / -
  - `ORD-1003` Ana, processing: 1 / - / -
  - `ORD-2001` Ben, pending: 1 / - / -
  - `ORD-2002` Ben, cancelled: 105 / - / -
  - `ORD-2003` Ben, delivered: 64 / 63 / 60 (outside the window: auto-rejected)
  - `ORD-2004` Ben, shipped: 3 / 1 / -
  `prisma db seed` keeps its current behavior (upsert customers and orders, nothing deleted), now with dates relative to when it runs.
- **Reset job** `prisma/demo-reset.ts`, `resetDemo(tx, now, passwordHash)` (the hash is computed once, outside the transaction), in one transaction:
  - upsert the five seeded accounts (three customers, operator, viewer) with the dev password hash, and the seven orders with relative dates;
  - delete every `RefundRequest` of the three demo customers;
  - delete the `UserMemory` rows of the three demo customers;
  - delete the LangGraph checkpoint rows of their threads (`thread_id` starting with `cus_ana:`, `cus_ben:` or `cus_cora:`) in `checkpoints`, `checkpoint_blobs` and `checkpoint_writes`, skipping a table that does not exist yet (the gateway creates them at startup);
  - leave everything else alone: `ChatTrace` and `LlmCall` (dashboard history and the daily budget's spend), the smoke-test customer `cus_smoke`, any other customer, `policy_chunks`, and the checkpoint migrations table.
  It is idempotent (two runs leave the same state), logs one summary line with counts only, and exits non-zero on failure (the transaction rolls back, so a failed reset changes nothing).
- **Running it**: a `demo-reset` one-off service in `docker-compose.prod.yml` (tools image, `jobs` profile, `npx tsx prisma/demo-reset.ts`), plus `deploy/demo-reset.sh`, `deploy/orderops-demo-reset.service` and `deploy/orderops-demo-reset.timer` (daily at 04:00 UTC, an hour after the 03:00 backup, `Persistent=true`), modeled on the backup files. Locally: `npm run demo:reset` (reads `.env`).
- **Visible credentials**: the console login screen shows the shared demo password under the customer list, with one line saying it also works with these emails on the API (`POST /auth/login`). The value comes from the console's server-side `DEMO_PASSWORD` (read in the server page and passed down), so the screen always matches what the console logs in with. Nothing is shown when it is unset. Rendered as plain text.
- **Docs**: `AGENTS.md` (reset command, what it clears and keeps, relative dates, timer), README (seed table and the refund walkthrough with relative dates: `ORD-1001` is refundable without the manual `UPDATE`, `ORD-2003` shows auto-reject; drop the "refunds are always auto_rejected" troubleshooting entry), `docs/deploy.md` (section 11 replaced with: run `demo-reset` once and install the timer, no `TRUNCATE`; "Demo console (Vercel)" item 4 says the reset restores the customers and `DEMO_PASSWORD` is the published dev password).

## Out of scope

- Deleting or rotating chat traces; resetting the daily budget; per-visitor data isolation.
- Changing the refund rules, the operator flow or any other gateway behavior.
- Separate production credentials or hiding operator/viewer access (the shared password opens them through the API, as the one-click console already does).
- Running the timer or any command on the real AWS instance: the runbook documents it, the owner runs it.
- Deploying the console to Vercel.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. No new dependency and no migration. Gates are `manual`. The reset is a destructive operation on shared data, so its delete filters are covered by tests and a live run against the local database (needs `docker compose up -d`; if Docker is not running, the build stops and asks the owner to start it).

## Build steps

- [x] 1. Relative demo data. `prisma/demo-data.ts` exports the accounts, `demoOrders(now)` and the dev password; `seed.ts` uses them. Done when: a spec with a fixed `now` shows the exact dates above and, using `refund-rules.ts`, that `ORD-1001` is eligible and `ORD-2003` is outside the window; the spec runs under `npm test` and `npm run typecheck:spec` (add `prisma/` to the spec tsconfig if it is not already included); `npx prisma db seed` runs against the local database and is still idempotent.
- [x] 2. Reset job. `prisma/demo-reset.ts` with `resetDemo(tx, now, passwordHash)` and a CLI entry; `demo:reset` script in `package.json`. Done when: a spec with a fake transaction client shows the upserts, the refund and memory deletes filtered to exactly the three demo customer ids, the checkpoint deletes with the three `thread_id` prefixes, a missing checkpoint table being skipped, and no call touching traces or other customers; a live run on the local database after creating a refund request and a thread for Ana (through the API or SQL) and a `cus_smoke` row shows Ana's refund, memory and checkpoints gone, orders back to the relative dates, traces and `cus_smoke` untouched, and a second run is a no-op.
- [x] 3. Host job. The `demo-reset` compose service, `deploy/demo-reset.sh`, the systemd service and timer. Done when: `docker compose -f docker-compose.prod.yml --env-file .env.production.example config -q` passes (required variables given dummy values), `bash -n deploy/demo-reset.sh` passes, and the unit files mirror the backup unit (user, working directory, `Requires=docker.service`).
- [x] 4. Credentials on the login screen. Done when: `web` typecheck, test and build pass; the build output shows the home page still builds with `cacheComponents`; and a Playwright check of `http://localhost:3005` (with the local stack running) shows the password line, and that logging in as Ana still works.
- [x] 5. Docs. Done when: `AGENTS.md`, README and `docs/deploy.md` match the scope above, with no remaining reference to the fixed seed delivery dates or to `TRUNCATE "Customer"`; `git diff` touches only files listed in this spec.

## Files / areas

- `prisma/demo-data.ts` (new, + spec), `prisma/seed.ts`, `prisma/demo-reset.ts` (new, + spec), `package.json` (script), `tsconfig.spec.json` if needed
- `docker-compose.prod.yml`, `deploy/demo-reset.sh`, `deploy/orderops-demo-reset.service`, `deploy/orderops-demo-reset.timer` (new)
- `web/src/app/page.tsx`, `web/src/components/console.tsx`, `web/src/components/login-view.tsx`
- `AGENTS.md`, `README.md`, `docs/deploy.md`

## Data / contracts

- Thread ids in the checkpoint tables are `<customerId>:<threadId>` (the same value as `RefundRequest.threadKey`); the delete matches the prefix `<customerId>:` exactly (no wildcard in the customer part, `LIKE` with the `:` included).
- Demo customer ids: `cus_ana`, `cus_ben`, `cus_cora`. The operator `op_sam` and viewer `view_vic` are upserted but own no refunds, memory or threads to clear.
- Dates are computed from `now` in whole days (`now - n * 86_400_000` ms); the reset passes the current time and specs pass a fixed one.
- Summary log line: `Demo reset: 5 accounts, 7 orders, <n> refund requests, <n> memories, <n> checkpoint rows removed`. No ids, emails or message text.
- The login screen's password comes from `DEMO_PASSWORD` (server-only env, already required by the console).

## Testing

- Unit (Vitest): relative dates and refund eligibility; reset calls and filters with a fake transaction client.
- Live: one run of seed and two runs of reset against the local Postgres, inspected with SQL; Playwright check of the login screen.
- Not run: the systemd timer and the job on AWS (documented for the owner).

## Notes for the AI

- Destructive: never widen a delete beyond the three demo customer ids or their `thread_id` prefixes. Use parameterized raw SQL for the checkpoint tables (`$executeRaw` tagged templates), never string concatenation.
- Check whether a checkpoint table exists with `to_regclass('public.<name>')` before deleting from it.
- Keep `seed.ts` non-destructive: the deletes live only in the reset.
- Evals and e2e specs use their own fixtures and are unaffected by the seed change; do not touch them.
- The tools image already contains `prisma/` and `tsx` (the `seed` and `smoke-user` jobs use them); confirm `demo-reset.ts` is covered by the same Dockerfile copy.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":9637,"specSha256":"f42088534d41cbb0d9bda5d762cc58479b720481db6d8055aea71f921a18819e","branch":"refs/heads/feature/nightly-demo-reset-and-visible-credentials","head":"0d69975aab28b6b18d56b27b5add3cf0c71c27df","baseRef":"refs/heads/master","baseCommit":"0d69975aab28b6b18d56b27b5add3cf0c71c27df","sourceTree":"37bcceb7ea77144574db545f48b4290ed2dfed2c","absentOptional":[]} -->
