# Fix: Drain interrupted turns on shutdown

**Type:** Fix
**Status:** verified
**Branch:** fix/drain-interrupted-turns-on-shutdown
**Fixes:** F-05

## The problem

F-05: when the gateway is stopped mid-stream (`docker compose stop orderops-agent`), the aborted turn's best-effort trace write fails with `trace write failed: PrismaClientKnownRequestError`. `SseConnections.beforeApplicationShutdown` (`apps/orderops-agent/src/chat/sse-connections.ts`) aborts and ends every open stream and returns at once, so Nest closes the HTTP server and `PrismaService.onApplicationShutdown` disconnects the database while the turn is still unwinding and its fire-and-forget `recordTrace` (`apps/orderops-agent/src/chat/chat.service.ts`, `finally` of `reply`) is running. Each interrupted turn loses its trace. No refund row is written for aborted turns, so this is trace loss only, not data corruption.

## The fix

Make the shutdown hook wait for the interrupted work before it returns, bounded so a stuck turn cannot hold shutdown past the 30 s `stop_grace_period`:

- `ChatService` keeps the trace writes it started in a `Set` of promises (removed when settled) and exposes `flushTraces()` that awaits them. `recordTrace` already never rejects.
- `SseConnections.track` returns a `done()` callback the controller calls in a `finally` after its loop ends. The hook, after ending the streams, waits (at most 5 s) for every tracked stream to call `done()`, then calls `chat.flushTraces()` (also bounded). Streams tracked after shutdown has started still end immediately and need no wait.
- `ChatController` calls `done()` when its handler finishes, whether it completed or threw.

No new dependency, module or config surface. Must not break: the `shutting_down` event contract, exit code 143 on stop, the 1 s graceful stop of an idle gateway (the drain returns at once when nothing is open), unit and e2e suites.

## Build steps

- [x] 1. Trace-write tracking in `ChatService`. Add the pending-writes set and `flushTraces()`; unit test in `chat.service.spec.ts` that `flushTraces()` resolves only after a deliberately slow fake trace store has finished writing, and resolves immediately when none is pending. Done when: that spec passes and `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit` is clean.
- [x] 2. Drain in `SseConnections` and the controller. `track` returns `done()`; the hook waits for released streams (bounded 5 s) and then `flushTraces()` (bounded); `ChatController` calls `done()` in a `finally`. Unit tests in `sse-connections.spec.ts`: the hook does not resolve until each stream calls `done()`; it resolves after the bound with fake timers when a stream never does; a stream tracked after shutdown needs no wait; `flushTraces` is awaited after the streams drain. Done when: `npm test`, `npm run lint`, `npm run typecheck:spec` and the three app typechecks pass.
- [x] 3. Live proof on the production compose stack. With the stack up locally (`API_DOMAIN=localhost`, scratch env file outside the repo, `seed` run for login): note the `ChatTrace` row count, start a `POST /chat` that streams for a while, `docker compose stop orderops-agent` mid-stream, then check: the stream received `shutting_down`, the container exited 143 within the grace period, the gateway log has no `trace write failed`, and the `ChatTrace` count increased by one with `status = 'aborted'`. Tear down with `down -v`. Done when all five observations hold; if the trace row is missing or the warning remains, record the observation in F-05 and do not mark it fixed.

## Verify

- Step 1-2 unit tests, `npm test`, `npm run lint`, `npm run typecheck:spec`, the three `tsc` checks and `npx nest build orderops-agent`.
- The step 3 observations, recorded in the final handoff.
- Mark F-05 `fixed`; `/audit` re-reviews before it closes.

## Notes

- Bounds: 5 s for in-flight turns, and the same bound for the trace flush, both well under the 30 s `stop_grace_period`; named constants in `sse-connections.ts`.
- `sse-connections.ts` gains a `ChatService` constructor dependency; both are already providers of `ChatModule`.
- The README and AGENTS.md describe the stop behavior only at the `shutting_down` level, so they stay unchanged unless the live proof shows otherwise.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":4262,"specSha256":"fdbb674e1165e95d30da47beb25d50b1601021e4edcb786d0573090d2af031a5","branch":"refs/heads/fix/drain-interrupted-turns-on-shutdown","head":"37eff6d8c590bc285debc6fdd363770eea22db69","baseRef":"refs/heads/master","baseCommit":"d423cec0aa4a7703ffa6bd8625f466d42436b378","sourceTree":"c4d6ef421012fcc2771f2cc05a45bc26f88c9d29","absentOptional":[]} -->

## Findings

### drain-interrupted-turns-on-shutdown/F-05 [P3] closed - Trace write for a turn aborted by shutdown races with the database disconnect

**File:** apps/orderops-agent/src/chat/sse-connections.ts:21
**Found:** 2026-10-19 by /implement (fix for F-02; scope: current; lens: quality)
**Why it matters:** With the stack stopped mid-stream (`docker compose stop orderops-agent`), the gateway logged `trace write failed: PrismaClientKnownRequestError` for the aborted turn. A plain client disconnect with the database alive logs no such warning, and a normal turn writes its trace. Ending the streams lets the server close at once, so `onApplicationShutdown` disconnects Prisma while the aborted turn is still unwinding and its fire-and-forget `recordTrace` runs. The write is best effort and aborted turns write no refund row, so the effect is one lost trace per interrupted turn, not data corruption.
**Suggested fix:** Have the shutdown hook wait (bounded, for example a few seconds) for the in-flight turns to settle before the server closes, for example by tracking each handler's completion promise next to its response. Needs a small design decision; accept the lost trace until item 10 (observability) if not worth it.
**Resolution:** `ChatService` tracks its trace writes and exposes `flushTraces()`; `SseConnections.track` returns a `done()` the controller calls in a `finally`, and the shutdown hook waits (5 s bound each) for the interrupted turns and then for the trace flush before Nest closes the server and Prisma disconnects. Proven on the production compose stack: stopping the gateway mid-stream delivered `shutting_down`, the container exited 143 after 1 s, the log had no `trace write failed`, and `ChatTrace` went from 0 to 1 row with status `aborted`.
**Closed:** 2026-10-19 by /audit independent current (fresh subagent, claude-sonnet-5-5). Verified in code: Nest's `runShutdownSequence` runs `beforeApplicationShutdown` before `dispose` (server close) and before `onApplicationShutdown` (Prisma disconnect), so awaiting there delays both only by the drain; the streams are already ended, so the close is not held. `ChatService.reply`'s `finally` adds the trace promise to `pendingTraces` before the controller's `finally` calls `done()`, so a flush that starts after all `done()`s sees every write from drained turns; both waits are bounded (5 s each, timers cleared in `finally`, max 10 s under the 30 s `stop_grace_period`). A handler throw still releases `done()` via `finally`. 78 chat tests, lint and both typechecks pass. Live Docker proof not re-run (unavailable).

## Independent review

**Status:** passed
**Target commit:** 37eff6d8c590bc285debc6fdd363770eea22db69
**Base commit:** d423cec0aa4a7703ffa6bd8625f466d42436b378
**Base ref:** refs/heads/master
**Spec hash:** fdbb674e1165e95d30da47beb25d50b1601021e4edcb786d0573090d2af031a5
**Prepared by:** claude
**Builder model:** claude-sonnet-5-5
**Requested reviewer:** claude
**Requested model:** runtime default (exact model not known until reviewer starts)
**Requested execution:** automatic
**Requested at:** 2026-10-19T16:41:55Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-sonnet-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-19T16:50:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

## Handoff

Review the active spec and the complete `<base>..<target>` delta in a fresh
session or isolated subagent without the builder conversation. Run all Audit lenses from scratch.
Run Check when required above. Do not edit product code, accept findings, or
reuse the existing findings as the review scope.

## Commands

- `git diff d423cec..37eff6d -- apps libs`: pass
- `npx vitest run apps/orderops-agent/src/chat`: pass (4 files, 78 tests)
- `npm run lint`: pass
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npm run typecheck:spec`: pass

## Evidence

- Installed `@nestjs/core` `runShutdownSequence`: destroy hooks, beforeApplicationShutdown, dispose (server close), onApplicationShutdown (Prisma disconnect); the new drain sits before the close and disconnect.
- `chat.service.ts` adds the trace promise to `pendingTraces` in the `finally` of `reply`, before `chat.controller.ts` calls `done()`; `flushTraces` runs only after all `done()`s or the timeout.
- `sse-connections.ts` `bounded` clears its timer in `finally`; total worst case 10 s versus `stop_grace_period: 30s`.
- Specs use real ordering assertions (order array, `finished` flags) and fake timers for both timeouts.

## Findings

- F-05 closed (resolved by the change).
- F-06 [P3] open: no test covers the controller's `finally { done() }` or the throw path.

## Remaining risk

- Docker and the live shutdown proof (exit 143, one aborted ChatTrace row, no `trace write failed`) could not be run; judged from code and the builder's recorded Resolution only.
- A turn still running after the 5 s drain timeout can write its trace after the database disconnects (accepted, best effort).
- F-06 test gap on the controller.
