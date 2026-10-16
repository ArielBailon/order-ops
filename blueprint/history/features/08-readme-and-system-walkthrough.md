# Feature: README and system walkthrough

**From build-plan:** feature 8
**Build attempt:** 1
**Status:** verified
**Branch:** feature/readme-and-system-walkthrough

## Goal

Replace the default NestJS README with real OrderOps documentation, written from
the codebase: what the system is, how to bring it up from a clean clone, and a
guided end-to-end test of every capability with copy-paste requests. A reader
who has never seen the repo must be able to reproduce the whole system, and
feature 9 (AWS deploy) later adds real metrics to this same file.

## In scope

- Rewrite `README.md` entirely (remove all NestJS template text, badges, Mau,
  Observe, donate and support sections).
- Sections, in order:
  1. What it is, with the feature list and the architecture diagram
     (`docs/architecture.png`, linked from `docs/architecture.html`).
  2. Prerequisites: Node, Docker, API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
     required; `AWS_REGION` optional for Bedrock), and the npm 10.9.3 install
     crash with the `npx -y npm@11 install` workaround.
  3. Setup, step by step: install, `.env` from `.env.example` with `JWT_SECRET`,
     `docker compose up -d`, `npx prisma migrate deploy` (and why not
     `migrate dev`), `npx prisma generate`, `npx prisma db seed`,
     `npm run ingest:policies`.
  4. Run: `npm run start:all`, or each app on its own, with ports and a health
     check that each one is up.
  5. Test the whole system by hand (Bash/curl form, with a PowerShell note for
     Windows): login as Ana, order lookup, FAQ, out-of-scope refusal, memory
     across turns with `threadId`, tenant isolation (Ben cannot see Ana's
     orders), refund request, operator list/approve/reject and thread resume,
     and each expected SSE event (`token`, `tool_call`, `approval_required`,
     `final`, `error`). Each step states what to expect.
  6. Automated checks: `npm test`, `npm run test:e2e`, `npm run lint`,
     `npx tsc -p apps/<app>/tsconfig.app.json --noEmit`, `npm run typecheck:spec`,
     `npm run build`.
  7. Observability: `npm run report:traces` and how to read it.
  8. Evals: `npm run eval` flags, `eval:compare`, `eval:regress`, cost cap,
     judge, and the GitHub eval workflow.
  9. Seed data table (users, roles, orders, statuses), troubleshooting, project
     layout map, and the user-facing reference for credentials and ports.
- A "Deployment" placeholder line stating AWS deploy is planned (feature 9).

## Out of scope

- Any code, schema, seed, or script change. If a documented command is broken,
  record it in the README troubleshooting or raise `/fix`; do not repair it here.
- AWS deploy instructions and real metrics (feature 9).
- Swagger, a frontend, new npm scripts, or a combined Verify command (`/ci`).
- Committing eval result files (none exist yet; the README says how to produce them).

## Build loop

`workflow.stepReview` is `feature`: implement all steps, then one review packet.
`checkpointCommits` is disabled. `/complete` creates the single feature commit.

## Build steps

- [x] 1. Skeleton and introduction: replace the template with title, summary,
  feature list, architecture section (diagram link), prerequisites and project
  layout map. Done when: no NestJS template text remains
  (`grep -i "nestjs.com\|Mau\|Discord" README.md` is empty) and every path in
  the layout map exists on disk.
- [x] 2. Setup and run: write the setup and run sections from `.env.example`,
  `docker-compose.yml`, `package.json` scripts and `AGENTS.md` Commands. Done
  when: a fresh-clone setup was executed against the README text, in order,
  through `npm run start:all`, and all three apps answered; any deviation was
  fixed in the README.
- [x] 3. Hands-on system test: write the guided walkthrough with the seed data
  table and every request. Done when: each request was run against the live
  system, the documented responses and SSE events match what was observed, and
  an unavailable provider key is reported as unverified instead of guessed.
- [x] 4. Automated checks, traces and evals: write those sections. Done when
  each documented command was run (or, for paid live evals, only
  `eval:compare` and `eval:regress` run, with the cost note on live runs) and
  its description matches the output.
- [x] 5. Troubleshooting and final pass: add troubleshooting from problems hit
  in steps 2-4, the deployment placeholder, and verify every relative link and
  code block. Done when: all links resolve, `npx prettier --check README.md`
  passes, and the README reads top to bottom as one working procedure.

## Files / areas

- `README.md` (rewritten)
- Read-only sources: `AGENTS.md` Commands, `.env.example`, `docker-compose.yml`,
  `package.json`, `prisma/seed.ts`, `apps/*/src/**/*.controller.ts`,
  `apps/orderops-agent/src/chat/chat.schemas.ts`, `evals/`, `docs/`,
  `.github/workflows/`.
- `docs/` (currently untracked) is committed with this feature because the
  README links to it.

## Data / contracts

Documented contracts must match the code:

- Endpoints: `POST :3000/auth/login`, `POST :3000/chat` (SSE),
  `GET :3000/refunds/pending`, `POST :3000/refunds/:id/approve|reject`,
  `GET :3001/orders`, `GET :3001/orders/:id`, `GET :3002/customers/me`.
- Seed users: ana (premium), ben, cora (customers) and operator@example.com;
  shared dev password `orderops-dev-password`. Orders ORD-1001..1003, 2001..2004.
- SSE events as defined in `chat.schemas.ts`.

## Testing

No logic changes, so no new tests. Verification is executing the README: a
fresh setup and every documented command and request. Report what could not be
run (for example a missing provider key) as unverified.

## Notes for the AI

- Write for a developer new to the repo; steps are numbered, commands are
  copy-paste, each followed by the expected result.
- Seed order dates are fixed (ORD-1001 delivered 2026-08-06, ORD-2003 delivered
  2026-06-05), and the 30-day refund window uses the real clock, so today they
  are outside the window and a refund on them auto-rejects. Document that as the
  "auto_rejected" example, and for the `pending_approval` and operator flow give
  a copy-paste SQL statement (via `docker exec orderops-postgres psql`) that sets
  an order's `deliveredAt` to a recent date. Confirm the real column and table
  names in `prisma/schema.prisma` first. Do not change the seed.
- Never put real keys or secrets in the README; use placeholders.
- Do not claim behavior you did not observe; copy response shapes from real runs.
- Keep the README one file. Use the existing `docs/` assets, do not generate more.

## Open questions

- None blocking. Decision recorded: the stale-seed-date issue is handled in the
  README with SQL, not by changing the seed. Say so if you prefer a seed change
  (that would be a separate `/fix`).


<!-- blueprint:completion {"schemaVersion":1,"specBytes":6808,"specSha256":"a66271339036c0d4761b944adebb23fd70facbfb62c60980c942d8f9042d4a80","branch":"refs/heads/feature/readme-and-system-walkthrough","head":"526efdcd74014c6f47822f7e598f338d4eb0c05c","baseRef":"refs/heads/master","baseCommit":"526efdcd74014c6f47822f7e598f338d4eb0c05c","sourceTree":"2b1b3b4ad1edd7c8df8255be4940566ff7830e80","absentOptional":[]} -->
