# Feature: Showcase

**From build-plan:** feature 13
**Build attempt:** 1
**Branch:** feature/showcase
**Status:** verified

## Goal

Give a reviewer a complete picture of OrderOps without running it: a "Live demo" section near the
top of the README with links to the live console and API, screenshots of the three console pages,
and real numbers measured on production (p95 latency, cost per conversation) and from the eval
suite (pass rates), each with its source, sample size and date. The demo video and the portfolio
link live outside this repo and are the owner's manual tasks; the README gets the video link only
once it exists.

## In scope

- A fresh Anthropic eval run on the current code, committed with `evals/COMPARISON.md`.
- One scripted batch of demo chats against production so the metrics rest on a real sample, then
  reading the numbers from the production observability API.
- Three screenshots of the live console (customer chat with timeline, operator console, dashboard)
  stored in `docs/screenshots/`.
- The README "Live demo" section: links, screenshots, a production metrics table, an eval table,
  and a "Demo video" line only when the owner has supplied the URL.

## Out of scope

- Recording, editing or hosting the video, and editing the portfolio site (owner, manual; see Notes).
- Any app, console, gateway or infrastructure code change. (Chat replies already render markdown
  since fix #8, `52c4359`, so the screenshots need no console change.)
- OpenAI or Bedrock eval runs and the LLM-as-judge metric (extra paid runs; not required by the
  plan line). The prompt-cache share: production shows 0%, which needs its own investigation, so
  the README does not quote it.
- A committed traffic or screenshot script. Both are one-off commands in the implementation session.

## Build loop

`workflow.stepReview` is `feature`: build all steps, then one review packet. `checkpointCommits` is
`disabled`: no commits between steps; `/complete` creates the feature commit. Steps 1-3 spend money
or write to production demo data and need the owner's yes in the chat before they run (costs below).

## Build steps

- [x] **1. Fresh eval run.** On `feature/showcase`, run `npm run eval -- --provider anthropic
  --max-cost 1.00` (about 0.51 USD last time; no judge), then `npm run eval:compare` and
  `npm run eval:regress`. Commit nothing yet; keep the new `evals/results/<UTC>-anthropic.json`
  and `evals/COMPARISON.md` in the working tree.
  Done when: the new result file's `gitSha` is the branch head, `summary.cases` is 41 and not
  `truncated`, `eval:regress` exits 0, and the pass rates (overall, route, tools, trajectory,
  guardrails, per category) are noted for step 4. If `eval:regress` exits 1, stop and report: a
  regression is a `/fix`, not something this feature papers over.

- [x] **2. Production metrics sample.** With the owner's yes, first read today's spend
  (`GET /observability/summary?since=<today 00:00 UTC>` as the viewer, `conversations.totalUsd`)
  and only start if it is below 0.40 USD, so the batch (about 40 chats, about 0.50 USD) stays under
  the 1.00 USD daily cap. Send the batch to `https://api.arielbailon.dev/chat` as Ana, Ben and
  Cora, at most 20 messages per customer per minute (the gateway allows 30): order lookups, policy
  questions, out-of-scope requests, a follow-up turn with `threadId` (memory), and refunds the rules
  reject (Ben, ORD-2003). No `pending_approval` refunds in the batch. Stop at the first reply with
  route `budget` or any `error` event and report it. Then read
  `GET /observability/summary?since=<batch start>` and `GET /observability/evals/latest`.
  Done when: the summary for the batch window shows at least 40 requests, no `budget` route, and
  the values for step 4 are recorded (requests, p50/p95 overall and by route, average and max cost
  per conversation, error and failover rate, window start and end).

- [x] **3. Screenshots.** With the owner's yes, capture three PNGs of
  `https://demo.arielbailon.dev` at a 1440x900 viewport into `docs/screenshots/`:
  `customer-chat.png` (Ana asks about ORD-1002 and the timeline panel is open), `operator.png` (one
  pending refund: Ana asks for a refund on ORD-1001 first; after the capture, approve it on the same
  page so no thread stays paused) and `dashboard.png` (Metrics view, 24h window, after step 2).
  Done when: the three files exist, each is under 500 KB, each shows the intended state, and none
  shows a token, cookie, API key or anything beyond the published demo password.

- [x] **4. README "Live demo" section.** Add `## Live demo` right after the intro paragraph (before
  the architecture image) in `README.md`, with: the console and API links and the demo password
  note; the three screenshots with alt text; a production table (requests and window, p50 and p95
  overall and per route, average cost per conversation, error and failover rate) stating that the
  sample is mostly the scripted demo batch of step 2 on production; an eval table from step 1
  (overall and per-metric pass rates, 41 cases, provider and model, run date, git sha) linking the
  result file and `evals/COMPARISON.md`; and one line on the guards (per-customer rate limit, 1.00
  USD daily cap). Add `**Demo video:** <url>` only if the owner has given the URL by then; never
  a placeholder.
  Done when: every number in the section matches the recorded step 1 and step 2 values, every
  relative link and image path exists in the repo, and the section renders correctly in the PR's
  GitHub preview.

## Files / areas

- `README.md` (new "Live demo" section only; the rest was refreshed in PR #7)
- `docs/screenshots/customer-chat.png`, `operator.png`, `dashboard.png` (new)
- `evals/results/<UTC>-anthropic.json` (new), `evals/COMPARISON.md` (new, generated)
- Read only: `GET /observability/summary`, `GET /observability/evals/latest`
  (`apps/orderops-agent/src/observability/`), `npm run eval` (`apps/orderops-agent/src/evals/`)

## Data / contracts

- Production numbers come only from `GET /observability/summary?since=<ISO>` with the viewer token
  (`requests`, `overall.p50/p95`, `byRoute[]`, `conversations.averageUsd/maxUsd`, `errorRate`,
  `failoverRate`). Latency in seconds with one decimal; USD with four decimals; rates as percent.
- Eval numbers come only from the step 1 result file's `summary` (`pass`, `metrics`, `byCategory`).
- Every table states its source, sample size and date, so a later reader can tell how old the
  numbers are. Numbers are not rounded up or selected; a weak value is shown as measured.

## Testing

- Documentation and data only: no unit or e2e test changes. `npm run eval:regress` is the check
  for step 1. The PR runs the required CI checks. Every changed path (`README.md`, `docs/**`,
  `evals/results/**`, `evals/COMPARISON.md`, `blueprint/**`) is in `deploy.yml`'s `paths-ignore`,
  so the merge does not start an API deploy; Vercel rebuilds the console with no change.
- Manual: open the README in the PR preview and follow each link and image.

## Notes for the AI

- Costs: step 1 about 0.51 USD (local, not counted by the daily cap); step 2 about 0.50 USD
  (counted by the cap); step 3 a few cents. Ask before each.
- Demo data changed by steps 2-3 (auto-rejected refunds, one approved refund, new threads and
  memory for the demo customers) is cleared by the 04:00 UTC nightly reset; traces stay, by design.
- Use the published demo password only; never print tokens or cookies in the chat or files.
- Owner's manual tasks (not build steps): record a 2-minute video (login, order lookup, policy
  question, refund with operator approval, dashboard), host it, and send the URL before step 4 if
  it should be in this PR; update the portfolio site's OrderOps entry to link the repo and the live
  console, replacing its "in progress" placeholder.



<!-- blueprint:completion {"schemaVersion":1,"specBytes":7856,"specSha256":"b17c5913ef4c62c55dbfa9be7b1feef35f564a6b490ad5bcd2e04cb6194e60c9","branch":"refs/heads/feature/showcase","head":"52c4359c6497c4dffd61e2889a3517a9277a0413","baseRef":"refs/heads/master","baseCommit":"52c4359c6497c4dffd61e2889a3517a9277a0413","sourceTree":"f034660dd21fbfa082c877428dd12b236a45971d","absentOptional":[]} -->
