# Fix: Write traces without blocking the stream

**Type:** Fix
**Status:** verified
**Branch:** fix/write-traces-without-blocking-the-stream
**Fixes:** F-11

## The problem

`ChatService.reply()` awaits `recordTrace` in its `finally`
([chat.service.ts](apps/orderops-agent/src/chat/chat.service.ts)). The controller
only ends the SSE response after the generator finishes, so a slow or unreachable
database (pool connect wait) keeps the stream open after the `final` event, even
though a failed trace write is already best-effort and only logged. Errors are
swallowed but the latency is not bounded.

## The fix

In `reply()`'s `finally`, start the write without awaiting it:
`void this.recordTrace(...)`. `recordTrace` already catches every error and logs
only the error name, so a rejected write cannot become an unhandled rejection and
the existing best-effort contract is unchanged. No timeout, queue, or new
abstraction: the write simply no longer sits on the response path.

Must not break: the trace content and status rules (`ok`, `error`, `aborted`), the
no-message-text rule, and that a throwing store never changes the emitted events.

## Build steps

- [x] 1. Make the write fire-and-forget and adjust the specs.
  Change the `finally` in `chat.service.ts`. In `chat.service.spec.ts` keep the
  existing trace tests (the store call still starts synchronously, so they hold)
  and add a test where `traces.record` returns a promise that never settles: the
  reply must still emit its final event and complete. Extend the existing
  "keeps the chat response when the store throws" test to wait a tick afterwards,
  proving the rejection is swallowed (no unhandled rejection) and the events are
  unchanged.
  **Done when:** the never-settling-store test completes (it would hang with the
  old `await`) and `npm test`, `npm run test:e2e`,
  `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`,
  `npm run typecheck:spec` and `npm run lint` pass.

## Verify

- Run the specs above; the never-settling-store test is the proof for the
  reported hang. A real database stall was not reproduced; say so in the handoff
  unless it is run.
- Manual (optional): stop Postgres, send a chat, and confirm the stream still ends
  right after `final` and one `trace write failed` warning is logged.
- `/audit` re-reviews F-11 (marked `fixed` by `/implement`) before it closes.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":2382,"specSha256":"76fd65fb9d25b0bfb19bf2a9106b82f7fba6eabea4f3cb92ecd464422becc25b","branch":"refs/heads/fix/write-traces-without-blocking-the-stream","head":"3ccc74c320c042f2f74a0d53631517413d75dd2c","baseRef":"refs/heads/master","baseCommit":"3ccc74c320c042f2f74a0d53631517413d75dd2c","sourceTree":"fdd3be5644cfb856c9fb147c45bd05991d50fd9e","absentOptional":[]} -->
