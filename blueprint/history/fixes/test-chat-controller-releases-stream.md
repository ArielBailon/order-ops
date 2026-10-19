# Fix: Test that the chat controller releases its stream

**Type:** Fix
**Status:** verified
**Branch:** fix/test-chat-controller-releases-stream
**Fixes:** F-06

## The problem

F-06: the shutdown drain depends on `ChatController.stream` (`apps/orderops-agent/src/chat/chat.controller.ts`) calling the `done()` returned by `SseConnections.track` on every exit, including when `chat.reply` throws. No spec exercises the controller; the `sse-connections.spec.ts` tests call `done()` by hand. Removing the `try/finally` would leave every test green while shutdown silently waited the full 5 s drain timeout and lost the trace race again.

## The fix

Test-only. Add `apps/orderops-agent/src/chat/chat.controller.spec.ts` that builds the controller directly with fakes (a `ChatService` whose `reply` is a controllable async generator, a `SseConnections` whose `track` returns a `vi.fn()` and records the call, and a fake express response with `status().set()`, `flushHeaders`, `write`, `end`, `on`/`once`) and calls `stream()`. No production code changes, no new dependency or test harness.

Cases:
- Normal completion: events are written as SSE frames, `res.end()` is called, `done` is called once, after the end.
- `chat.reply` throws mid-stream: the returned promise rejects with that error, `done` is still called once.
- Client closes while streaming (`res` emits `close`, which aborts the signal): the loop stops writing, `done` is called once.

Must not break: the existing chat specs and e2e behavior (nothing production changes).

## Build steps

- [x] 1. Add the controller spec with the three cases. Done when: `npx vitest run apps/orderops-agent/src/chat/chat.controller.spec.ts` passes; as a sanity check that the tests really guard the behavior, temporarily removing the `finally { done(); }` in `chat.controller.ts` makes the throw-path case fail (the abort-path case guards a different regression: removing `done()` entirely fails all three) (restore the file afterwards and confirm `git diff` shows no change to `chat.controller.ts`); then `npm test`, `npm run lint`, `npm run typecheck:spec` and the app typecheck pass.

## Verify

- The mutation check above (record which cases failed without the `finally`).
- `npm test`, `npm run lint`, `npm run typecheck:spec`, `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`.
- Mark F-06 `fixed`; `/audit` re-reviews before it closes.

## Notes

- Test-only change: no live Docker proof is needed.
- Keep the fakes minimal (only what `stream()` touches); do not import Nest's testing module or start an HTTP server.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2582,"specSha256":"39a048f1381c6403b0756782eca48f089eea92478f304940408ad56871279281","branch":"refs/heads/fix/test-chat-controller-releases-stream","head":"ebe370ae91937d4bf99447cd2b57354a512f9fc4","baseRef":"refs/heads/master","baseCommit":"ebe370ae91937d4bf99447cd2b57354a512f9fc4","sourceTree":"495af5c97dc0a8441014fb81fba19aad4e9a2f68","absentOptional":[]} -->
