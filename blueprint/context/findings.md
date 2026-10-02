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

### F-11 [P3] unverified - Partial unique index exists only in hand-written SQL

**File:** prisma/migrations/20261001120000_refund_requests/migration.sql:33
**Found:** 2026-10-01 by /audit independent (scope: current; lens: quality)
**Why it matters:** The partial unique index is not modeled in schema.prisma, so a later prisma migrate diff may report drift or propose dropping it. Not confirmed without running a database. The migration SQL itself matches the schema.
**Suggested fix:** Document it next to the model (done in a schema comment) and re-check drift output when the next migration is generated.
**Resolution:** 2026-10-02 independent review of 5f9ba3b: the committed `20261002120000_operator_role/migration.sql` contains no `DROP INDEX`; raw `prisma migrate diff` output was not re-run (needs a database), so drift remains unverified. Re-checked 2026-10-02 against f930c70: migration unchanged (CREATE TYPE plus two ADD COLUMN, no DROP INDEX); still unverified for the same reason. Re-checked 2026-10-02 against f76b920: migration unchanged; still unverified (no database run in review).

### F-20 [P3] unverified - Per-customer advisory lock in the memory store was never run against Postgres

**File:** apps/orderops-agent/src/memory/user-memory.store.ts:26
**Found:** 2026-10-02 by /audit (scope: current; lens: quality, performance, tests)
**Why it matters:** The store spec fakes the Prisma client, so it proves call order but not that `$executeRaw` accepts the `SELECT pg_advisory_xact_lock(...)` statement through the PrismaPg adapter, nor that concurrent `add` calls really serialize. If the statement were rejected, every fact write would fail and only log "memory write failed", so long-term memory would silently stop updating.
**Suggested fix:** Check once against the dev database: send two simultaneous chat turns for one customer that each state a different preference and confirm both facts land in `UserMemory.facts`. No code change expected.
**Resolution:**
