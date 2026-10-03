# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-09 [P3] open - Stored refund reason depends on the model and is untrusted text for operators

**File:** apps/orderops-agent/src/agent/refund-route.ts:100
**Found:** 2026-10-01 by /audit independent (scope: current; lens: security)
**Why it matters:** The 'reason required' guard and the stored reason both depend on the model. It can invent a reason, and injected text can end up in the stored reason that operators will read in feature 4b. Amount and order cannot escape the code-enforced rules or the owner check.
**Suggested fix:** Accept for 4a. In 4b, show the reason to operators as quoted data.
**Resolution:** 2026-10-02 independent review of 5f9ba3b: `GET /refunds/pending` returns `reason` only as a JSON string value and AGENTS.md labels it untrusted customer text, which applies the 4b suggestion. The model-dependent reason itself remains; status left for the builder/user to set. Re-checked 2026-10-02 against f930c70: unchanged (refund.store.ts:54-55 and :176 return it as plain JSON data); still open pending a user decision to accept or close. Re-checked 2026-10-02 against f76b920: unchanged; still open.

