# Findings

> **Generated file.** The findings ledger: review findings raised by `/audit`
> against the work in progress, each with a durable ID, severity (P0-P3), and
> status. `/implement` marks repaired findings `fixed`, a later `/audit` pass
> moves them to `closed`, and `/complete` refuses to merge while any P0 or P1
> finding is `open` or `fixed`, then archives resolved findings with the work
> and resets this file.

### F-05 [P3] open - Fact merge is a read-modify-write, so concurrent turns of one customer can lose facts

**File:** apps/orderops-agent/src/agent/agent.graph.ts:136
**Found:** 2026-10-01 by /audit (scope: current; lens: quality)
**Why it matters:** `remember` reads the facts, merges, then replaces the whole array. Two simultaneous requests from the same customer (different threads or two tabs) can overwrite each other and drop a just-extracted fact. The spec excludes only same-thread concurrency. Impact is a lost note, not corruption.
**Suggested fix:** Accept as a documented limitation, or merge inside one Prisma transaction. No current requirement is lost either way.
**Resolution:** 2026-10-02 independent review of f930c70: `remember` node (agent.graph.ts:182-200) unchanged by this feature; still open. Re-checked 2026-10-02 against f76b920: unchanged; still open.

### F-09 [P3] open - Stored refund reason depends on the model and is untrusted text for operators

**File:** apps/orderops-agent/src/agent/refund-route.ts:100
**Found:** 2026-10-01 by /audit independent (scope: current; lens: security)
**Why it matters:** The 'reason required' guard and the stored reason both depend on the model. It can invent a reason, and injected text can end up in the stored reason that operators will read in feature 4b. Amount and order cannot escape the code-enforced rules or the owner check.
**Suggested fix:** Accept for 4a. In 4b, show the reason to operators as quoted data.
**Resolution:** 2026-10-02 independent review of 5f9ba3b: `GET /refunds/pending` returns `reason` only as a JSON string value and AGENTS.md labels it untrusted customer text, which applies the 4b suggestion. The model-dependent reason itself remains; status left for the builder/user to set. Re-checked 2026-10-02 against f930c70: unchanged (refund.store.ts:54-55 and :176 return it as plain JSON data); still open pending a user decision to accept or close. Re-checked 2026-10-02 against f76b920: unchanged; still open.

### F-11 [P3] unverified - Partial unique index exists only in hand-written SQL

**File:** prisma/migrations/20261001120000_refund_requests/migration.sql:33
**Found:** 2026-10-01 by /audit independent (scope: current; lens: quality)
**Why it matters:** The partial unique index is not modeled in schema.prisma, so a later prisma migrate diff may report drift or propose dropping it. Not confirmed without running a database. The migration SQL itself matches the schema.
**Suggested fix:** Document it next to the model (done in a schema comment) and re-check drift output when the next migration is generated.
**Resolution:** 2026-10-02 independent review of 5f9ba3b: the committed `20261002120000_operator_role/migration.sql` contains no `DROP INDEX`; raw `prisma migrate diff` output was not re-run (needs a database), so drift remains unverified. Re-checked 2026-10-02 against f930c70: migration unchanged (CREATE TYPE plus two ADD COLUMN, no DROP INDEX); still unverified for the same reason. Re-checked 2026-10-02 against f76b920: migration unchanged; still unverified (no database run in review).

### F-12 [P3] open - Duplicate store test and redundant e2e mock reset

**File:** apps/orderops-agent/src/refunds/refund.store.spec.ts:105
**Found:** 2026-10-01 by /audit independent (scope: current; lens: tests)
**Why it matters:** "rethrows an insert failure that is not a duplicate open request" repeats "rethrows an insert failure that is not a unique violation even if a request is open" with weaker assertions, so it adds no coverage. In chat.e2e-spec.ts the auto-reject test re-applies the same createRefund mock that beforeEach already sets. Harmless noise that hides which cases are distinct.
**Suggested fix:** Delete the weaker duplicate test and the redundant mockImplementation. No coverage or requirement is lost.
**Resolution:** 2026-10-02 independent review of f930c70: still present (refund.store.spec.ts:82 and :105; chat.e2e-spec.ts:98 and :343); line reference updated. Re-checked 2026-10-02 against f76b920: still present at the same lines; still open.

