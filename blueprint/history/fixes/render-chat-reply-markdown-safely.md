# Fix: Render chat reply markdown safely

**Type:** Fix
**Status:** verified
**Branch:** fix/render-chat-reply-markdown-safely

## The problem

The demo console shows the agent's replies with the model's markdown as literal text: `**Return
window:**`, `- ` bullets and blank-line paragraphs appear exactly as typed (seen in production on
an FAQ answer and an order lookup). `web/src/components/chat-view.tsx:239` renders an assistant
message as one `<p>{message.text}</p>`, and `.message p { white-space: pre-wrap }` in
`web/src/app/globals.css` keeps every character. It makes the demo look broken, and the item 13
screenshots would show it.

The reply text is model output, influenced by the customer's message and by stored data, so it is
untrusted: it must never reach the page as HTML.

## The fix

Render the small subset of markdown the agent actually produces, as React elements, so React
escapes every piece of text and no HTML from the reply is ever interpreted.

- `web/src/lib/markdown.ts` (new, pure): parse reply text into blocks:
  - paragraphs, split on blank lines; single line breaks inside a paragraph are kept;
  - bullet lists (lines starting with `- ` or `* `) and numbered lists (`1. `, `2. `);
  - headings (`#` to `###`), shown as a bold paragraph, not a large title;
  - inline: `**bold**` and `` `code` ``. An unclosed `**` or backtick (common mid-stream) stays as
    literal text until it closes.
  Everything else, including links, images, tables and raw HTML such as `<b>` or `<script>`, stays
  plain text. No `dangerouslySetInnerHTML`, no new dependency.
- `web/src/components/chat-view.tsx`: assistant messages render through the parsed blocks
  (`<p>`, `<ul>`, `<ol>`, `<li>`, `<strong>`, `<code>`). User messages and operator updates stay
  plain text, as now.
- `web/src/app/globals.css`: list and inline-code styles inside `.message`, consistent with the
  existing message styles.

Must not break: streaming (the reply re-renders on every `token` event), the timeline selection
and "Show timeline" button, the approval, failed and interrupted notes under a reply, and the
gateway's SSE contract (no gateway change).

## Build steps

- [x] **1. Parser with tests.** Add `web/src/lib/markdown.ts` and `web/src/lib/markdown.spec.ts`.
  Done when `npm test` in `web/` passes with cases for: plain text unchanged; paragraphs; line
  breaks; `- ` and `* ` bullets; numbered lists; a heading; `**bold**` and `` `code` `` inside
  list items; unclosed `**` and backtick left literal; `<script>alert(1)</script>` and
  `[link](http://x)` left as plain text; empty string gives no blocks.
- [x] **2. Render it in the chat.** Use the parser for assistant messages in `chat-view.tsx` and
  add the CSS. Done when `npm run typecheck`, `npm test` and `npm run build` pass in `web/`, and the
  local console (`npm run dev`, three apps running) shows "What is your return policy?" as a
  bulleted list with bold labels and no `**` or `- ` characters, while a reply still streams in
  token by token.

## Verify

- Local console: ask "What is your return policy?" and "Where is my order ORD-1002?" as Ana. Both
  replies show real bullets and bold text, with no markdown characters left over.
- Send `Reply with exactly this text: <b>hi</b> <script>alert(1)</script>`. If the reply echoes
  it, the tags show as text and no script runs (in any case the parser test covers this).
- After merge, the console on Vercel shows the same (Vercel deploys `master`).


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3480,"specSha256":"7ba65cd14d8dab2dafddd175db3b788455e32c4b35ff25622b8b0e7ac666e369","branch":"refs/heads/fix/render-chat-reply-markdown-safely","head":"f58284e32fb28754f7cb602729115403048f6b3b","baseRef":"refs/heads/master","baseCommit":"f58284e32fb28754f7cb602729115403048f6b3b","sourceTree":"7dc7751a8f809604f0791f6c5bd1177025ea40bc","absentOptional":[]} -->

## Findings

### render-chat-reply-markdown-safely/F-08 [P3] closed - IMDS hop limit 2 exposes the instance role to every container while Bedrock is off

**File:** docs/deploy.md:204
**Found:** 2026-10-20 by /audit independent current (scope: current; lens: security)
**Why it matters:** `HttpPutResponseHopLimit=2` lets any container, including internet-facing Caddy and the LLM gateway, fetch the role credentials (SSM core, log writes, backup `PutObject`) after an SSRF or container compromise. The doc justifies it only for Bedrock, which is disabled (`AWS_REGION` empty) and unverified. IMDSv2 is still required, so the exposure is modest.
**Suggested fix:** Keep the default hop limit of 1 now and raise it to 2 (`aws ec2 modify-instance-metadata-options`) in the "Bedrock check" step, noting the tradeoff. Nothing is lost today because Bedrock is not in use.
**Resolution:** docs/deploy.md now launches with HttpPutResponseHopLimit=1 (note rewritten) and the "Bedrock check" section raises it to 2 with `aws ec2 modify-instance-metadata-options`, names the credentials-exposure tradeoff and how to set it back to 1. Docs only: the RUNNING instance still has hop limit 2 until the owner runs that command with 1 (a separate, explicit AWS action), and the Bedrock step was not exercised because Bedrock access is suspended.
**Re-review 2026-10-22:** Docs verified (launch command hop limit 1, Bedrock step raises and reverts it). Kept as fixed, not closed: the RUNNING instance still has hop limit 2, so the exposure the finding describes persists until the owner runs the modify-instance-metadata-options command with 1.
**Re-review 2026-10-24:** Live check (`aws ec2 describe-instances`, read-only): instance `i-0f94735086b328aa3` still has `HttpTokens=required`, `HttpPutResponseHopLimit=2`. Kept as fixed. Closes after the owner runs `aws ec2 modify-instance-metadata-options --instance-id i-0f94735086b328aa3 --http-put-response-hop-limit 1 --http-tokens required` and a later audit confirms hop limit 1.
**Applied 2026-10-24 (owner-approved):** `modify-instance-metadata-options` ran; `describe-instances` shows `State=applied`, `HttpTokens=required`, `HttpPutResponseHopLimit=1`, and production stayed healthy (`/health` 200, demo login 200). Kept as fixed until the next audit pass re-examines and closes it.
**Re-review 2026-10-24 (closed):** Live (read-only `aws ec2 describe-instances`): `State=applied`, `HttpTokens=required`, `HttpPutResponseHopLimit=1`, `HttpEndpoint=enabled`. Runbook consistent: `docs/deploy.md:204` launches with hop limit 1, line 218 explains it, and the Bedrock check (lines 640-652) raises it to 2 only when Bedrock is in use and says how to set it back. Bedrock stays off in production, so no container needs the instance metadata. Exposure described by the finding is gone; no new defect found.

### render-chat-reply-markdown-safely/F-19 [P3] closed - Production deploy approval can be a self-approval; no branch ruleset confirmed

**File:** docs/deploy.md:445
**Found:** 2026-10-22 by /audit (scope: path; lens: security; builder session, not an independent review)
**Why it matters:** The deploy role may run any shell command as root on the instance (`ssm:SendCommand` on `AWS-RunShellScript`), so control of `deploy.yml` on `master` is control of the host and its `.env.production`. The `production` environment requires a reviewer, but the only account is the author and "Prevent self-review" is off, and the branch ruleset (runbook step C4) was optional and is not confirmed to exist. With no ruleset, a direct push to `master` can change the workflow and the author can approve it. This is acceptable for a solo demo; it matters once anyone else has write access.
**Suggested fix:** Confirm the `master` ruleset exists (require a pull request and the `checks`, `integration`, `docker` and `deterministic` checks), and turn on "Prevent self-review" if a second reviewer is ever added. Missing validation: the repository settings were not inspected.
**Resolution:**
**Re-review 2026-10-24 (confirmed, unverified -> open):** Read-only `gh api` checks: `repos/ArielBailon/order-ops/rulesets` returns no rulesets and `branches/master/protection` answers 404 "Branch not protected"; the `production` environment has a `required_reviewers` rule with 1 reviewer and no `prevent_self_review`. Consequence seen today: every change went straight to `master`, so the pull-request-only `ci.yml` and the evals `deterministic` job did not run on 12a-12c or the two deploy fixes (local runs covered lint, typechecks, unit, e2e and web, but not the schema-drift check). Owner decision pending: add the ruleset (changes the workflow to push a branch and open a pull request per item) or accept with a recorded reason (single maintainer).
**Fix applied 2026-10-24 (owner decision: add the ruleset):** ruleset `master` (id 25785858, active, target `~DEFAULT_BRANCH`, no bypass actors): blocks deletion and non-fast-forward pushes, requires a pull request (squash only, 0 approvals since there is one maintainer) and the status checks `checks`, `integration`, `docker (orderops-agent)`, `docker (orders-service)`, `docker (customers-service)`, `docker (tools)`, `web` and `deterministic` (`gh api repos/ArielBailon/order-ops/rules/branches/master` lists all four rules). Corrected the same day: the ruleset first required a plain `docker`, which the `docker` matrix never reports, and that blocked PR #5 until the four per-image names replaced it. Every change now reaches `master` through a pull request, so PR CI runs before deploy. Still single-maintainer: the `production` environment approval remains a self-approval. Awaiting re-review.
**Re-review 2026-10-24 (closed):** Live (read-only `gh api`): ruleset 25785858 `active`, target `~DEFAULT_BRANCH`, 0 bypass actors, rules deletion, non_fast_forward, pull_request (squash only) and required_status_checks with the eight names above; the `production` environment deploys only from `master` (deployment branch policy `branch:master`) and keeps 1 required reviewer. `deploy.yml` runs on pushes to `master` and manual dispatch, both gated by that environment. The defect described (a direct push to `master` changing the deploy workflow) is gone: every change now needs a pull request whose eight checks pass, as PR #5 and PR #6 showed. Residual risk, as the finding already accepted for a solo maintainer: the environment approval is a self-approval (`prevent_self_review` false); turn it on if a second reviewer is added. Runbook C4 and `AGENTS.md` match the live ruleset (fix required-check-names-in-the-runbook-and-f-19). No new defect found.
