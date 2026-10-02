# Fix: Atomic fact merge and test cleanup

**Type:** Fix
**Status:** verified
**Branch:** fix/atomic-fact-merge-and-test-cleanup
**Fixes:** F-05, F-12

## The problem

- **F-05.** The `remember` node in [agent.graph.ts](apps/orderops-agent/src/agent/agent.graph.ts) reads a customer's stored facts, merges the new ones in memory, then replaces the whole array through `UserMemoryStore.replace`. Two simultaneous requests from the same customer (two tabs or threads) can read the same array, and the later write drops the other's new fact. The first write for a customer can also race on the missing row.
- **F-12.** [refund.store.spec.ts](apps/orderops-agent/src/refunds/refund.store.spec.ts) has a test ("rethrows an insert failure that is not a duplicate open request", near line 105) that repeats a stronger one with weaker assertions. In [chat.e2e-spec.ts](apps/orderops-agent/test/chat.e2e-spec.ts) the auto-reject test (near line 343) re-applies a `createRefund` mock that `beforeEach` already sets.

## The fix

- **F-05.** Replace `UserMemoryStore.replace(customerId, facts)` with `add(customerId, added)`. `PrismaUserMemoryStore.add` runs one `prisma.$transaction` that first takes a per-customer lock (`pg_advisory_xact_lock(hashtext(customerId))` through `$executeRaw`, which also covers the missing-row case), then reads the row, applies the existing pure `mergeFacts`, and upserts. `remember` calls `memory.add(customerId, added)` and keeps its current log-and-continue handling of a failure. `get` stays as is for reading context. No new dependency and no schema change.
- **F-12.** Delete the weaker duplicate store test and the redundant `mockImplementation` in the e2e auto-reject test. Nothing else in those files changes.
- Must not break: `mergeFacts` semantics (dedupe, length cap, newest facts kept) and the rule that a memory failure never fails the chat turn.

## Build steps

- [x] 1. **F-12: remove the duplicate test and redundant mock.** Delete the weaker store test and the e2e mock line. Done when: the remaining store tests still cover a non-unique insert failure with an open request present, and `npm test` and `npm run test:e2e` pass with two fewer or equal assertions lost (one test fewer in the store spec).
- [x] 2. **F-05: atomic add in the store.** Change the interface, implement `PrismaUserMemoryStore.add` as described, update the `remember` node, the fake in `chat.service.spec.ts` (`get` and `add`), and the affected graph tests. Add `user-memory.store.spec.ts` with a fake Prisma client showing: the lock statement runs before the read inside the transaction, new facts are merged with the stored ones, a missing row is created, and an empty `added` list writes nothing. Done when: `npm test`, `npm run test:e2e`, `npm run typecheck:spec`, app typecheck for all three apps and `npm run lint` pass, and F-05 and F-12 are marked `fixed`.

## Verify

- Unit and e2e suites above. The advisory lock and real concurrent writes are not exercised without a database, so check once manually: start Postgres, send two chat turns that each state a different preference at the same time for one customer, and confirm both facts are in `UserMemory.facts`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3189,"specSha256":"10419c0dfad5cd8d538e864b4ebafea6544d5e0de47cd440b1677f3cbb785686","branch":"refs/heads/fix/atomic-fact-merge-and-test-cleanup","head":"a0f58fed2fdc3126364f3b40734735ca7170085a","baseRef":"refs/heads/master","baseCommit":"a0f58fed2fdc3126364f3b40734735ca7170085a","sourceTree":"888c932a373e34787a4f5a90ef325abe976f86f1","absentOptional":[]} -->

## Findings

### atomic-fact-merge-and-test-cleanup/F-05 [P3] closed - Fact merge is a read-modify-write, so concurrent turns of one customer can lose facts

**File:** apps/orderops-agent/src/agent/agent.graph.ts:136
**Found:** 2026-10-01 by /audit (scope: current; lens: quality)
**Why it matters:** `remember` reads the facts, merges, then replaces the whole array. Two simultaneous requests from the same customer (different threads or two tabs) can overwrite each other and drop a just-extracted fact. The spec excludes only same-thread concurrency. Impact is a lost note, not corruption.
**Suggested fix:** Accept as a documented limitation, or merge inside one Prisma transaction. No current requirement is lost either way.
**Resolution:** 2026-10-02 independent review of f930c70: `remember` node (agent.graph.ts:182-200) unchanged by this feature; still open. Re-checked 2026-10-02 against f76b920: unchanged; still open. 2026-10-02 fixed on fix/atomic-fact-merge-and-test-cleanup: `UserMemoryStore.add` merges inside one transaction behind a per-customer `pg_advisory_xact_lock`, and `remember` calls it instead of read-merge-replace. Store spec covers lock-before-read order, merge, missing row and the fact cap. The lock and real concurrent writes were not run against a database. Awaiting re-review. Closed 2026-10-02 by /audit current (fresh review, base a0f58fe): user-memory.store.ts:25-36 takes pg_advisory_xact_lock(hashtext(customerId)) before the read inside one transaction, so concurrent turns for one customer queue and cannot overwrite each other, and the lock also covers a missing row; agent.graph.ts:192 now calls add. The new store spec asserts lock-read-write order, merge, row creation and the cap. The lock itself was not run against a database (see F-20).

### atomic-fact-merge-and-test-cleanup/F-12 [P3] closed - Duplicate store test and redundant e2e mock reset

**File:** apps/orderops-agent/src/refunds/refund.store.spec.ts:105
**Found:** 2026-10-01 by /audit independent (scope: current; lens: tests)
**Why it matters:** "rethrows an insert failure that is not a duplicate open request" repeats "rethrows an insert failure that is not a unique violation even if a request is open" with weaker assertions, so it adds no coverage. In chat.e2e-spec.ts the auto-reject test re-applies the same createRefund mock that beforeEach already sets. Harmless noise that hides which cases are distinct.
**Suggested fix:** Delete the weaker duplicate test and the redundant mockImplementation. No coverage or requirement is lost.
**Resolution:** 2026-10-02 independent review of f930c70: still present (refund.store.spec.ts:82 and :105; chat.e2e-spec.ts:98 and :343); line reference updated. Re-checked 2026-10-02 against f76b920: still present at the same lines; still open. 2026-10-02 fixed on fix/atomic-fact-merge-and-test-cleanup: deleted the weaker duplicate store test and the redundant e2e mock reset; the stronger test still covers the case. Awaiting re-review. Closed 2026-10-02 by /audit current: the weaker duplicate test is gone and the stronger one (refund.store.spec.ts:82) still asserts the non-unique failure with an open request and no duplicate lookup; the e2e auto-reject test relies on the beforeEach mock, which is identical. No coverage lost.
