# Feature: Langfuse spans

**From build-plan:** feature 10c
**Build attempt:** 1
**Branch:** feature/langfuse-spans
**Status:** verified

## Goal

Every chat request also produces a per-node span tree in Langfuse Cloud, recorded through the LangChain callback handler under the same trace id as the stored `ChatTrace`, so a trace in the observability API (10b) can be opened in Langfuse. Per the owner's decisions, spans carry **metadata only** (no customer text, prompts, replies, tool arguments, tool results, or the caller's token), and Langfuse is **optional**: it is on only when both keys are set, and the app behaves exactly as today without them or when Langfuse is unreachable.

## In scope

- **Dependency**: the currently supported Langfuse package(s) for LangChain.js, chosen and pinned in step 1 after reading the official docs. It is a new runtime dependency, authorized by build-plan item 10c.
- **Configuration**: `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (optional, both or neither; one alone fails startup with a clear message), `LANGFUSE_BASE_URL` (optional URL, default the Langfuse Cloud URL named in the docs). Added to `env.ts`, `.env.example`, `.env.production.example`, and passed through (empty by default) to `orderops-agent` in `docker-compose.prod.yml`.
- **Handler per request**: when enabled, `ChatService.reply` adds a Langfuse callback handler next to the existing `TraceCollector`, bound to the request's trace id (`TraceCollector.id` from 10a, or a documented deterministic mapping of it if Langfuse requires another format), with session id = the client `threadId` and user id = `customerId` only if step 1 confirms these are plain metadata fields (they are already visible to viewers in 10b).
- **Masking** before anything is sent: inputs and outputs of every observation are replaced by a fixed placeholder, and run metadata keeps only an allowlist of non-sensitive keys (for example node name, model name, provider, step); everything else, including `token` (LangChain copies primitive `configurable` values such as the caller JWT into run metadata), `customerId` and `thread_id` duplicates, is dropped. Names, timings, token usage, model, errors and status remain.
- **Failure isolation**: a Langfuse error, timeout or outage never changes the chat response or the stored `ChatTrace`; the handler must not raise into the graph run.
- **Shutdown**: pending Langfuse events are flushed in the existing shutdown drain (`SseConnections.beforeApplicationShutdown` calls `ChatService.flushTraces`), bounded by the same timeout.
- **Docs**: `AGENTS.md`, README and `docs/deploy.md` describe the keys, that spans are metadata-only, the trace id mapping, and that production keys are typed on the server like the other secrets.

## Out of scope

- Sending any message, prompt, reply, tool argument or result to Langfuse, in any environment.
- Langfuse in the eval runner (it builds its own callbacks; evals stay keyless and unchanged), in orders-service or customers-service.
- Linking from the API to Langfuse (no new field in 10b's responses); the console link is item 11c.
- Langfuse prompt management, scores, datasets, or self-hosting; an OpenTelemetry setup beyond what the chosen Langfuse package itself requires.
- Creating the Langfuse account or project, and putting keys on the production host: owner actions, described in the docs.

## Build loop

`workflow.stepReview` is `feature` and `checkpointCommits` is `disabled`: implement the steps in order, one review packet at the end, no per-step pauses or checkpoint commits. Step 1 needs network access (reading the Langfuse docs and installing a package from npm); that is authorized by approving this spec. The independent review gate is `manual`; this feature sends data to an external service, so `/audit independent current` before `/complete` is recommended and will be offered in the final packet. The live check at the end needs the owner's Langfuse keys and runs only with the owner's go-ahead.

## Build steps

- [x] 1. Choose and install the package. Read the official Langfuse docs for LangChain.js and pick the currently supported package and version. Confirm from the docs (and the package's types after install) four things: (a) how to set a trace id, and whether `TraceCollector.id` (a UUID v4) can be used as is or needs a mapping; (b) how to mask or transform inputs, outputs and metadata before sending; (c) how to flush and shut down; (d) that callback errors are not raised into the run. Install with `npx -y npm@11 install` (the bundled npm crashes on this project). Done when: `package.json` and `package-lock.json` pin the chosen version, the three app typechecks pass, and the final report quotes the doc page and the exact API used for (a) to (d). If any of (a) to (d) is not supported, stop and revise this spec instead of working around it.
- [x] 2. Configuration. Optional keys and base URL in `env.ts` with the both-or-neither rule, the two `.env` examples, and the compose pass-through. Done when: `env.spec.ts` shows both keys absent is valid and disabled, both present is valid and enabled, exactly one present fails with a message naming the missing key, an invalid base URL fails, and the default base URL applies; `docker compose -f docker-compose.prod.yml config -q` still passes with no Langfuse variables set.
- [x] 3. Masking. A small pure module (for example `apps/orderops-agent/src/trace/langfuse-mask.ts`) that turns any observation payload into the metadata-only form. Done when: a spec shows inputs and outputs replaced by the placeholder for chat-model, chain, tool and retriever shapes (strings, message arrays, objects), the caller token, message text and tool arguments absent from the result (asserted by searching the serialized output for fixture secrets), allowlisted metadata kept, unknown metadata keys dropped, and token usage, model name, timings and error status kept.
- [x] 4. Handler wiring and shutdown. A provider that is null when disabled and otherwise builds a per-request handler with the request's trace id and the masking from step 3; `ChatService.reply` adds it to `callbacks` only when present; `flushTraces` also flushes Langfuse. Done when: `chat.service.spec.ts` shows no Langfuse handler without keys (callbacks unchanged from today), one handler bound to `TraceCollector.id` (or its documented mapping) with keys, the reply and the stored trace unchanged when the handler throws on every callback, and `flushTraces` awaiting the Langfuse flush; the e2e suite passes unchanged without keys.
- [x] 5. Docs. `AGENTS.md` (variables, metadata-only rule, trace id mapping, optional), README (one paragraph), `docs/deploy.md` (adding the keys to `.env.production` on the host, region and base URL). Done when: all three name the variables, state that no message text leaves the server, and `git diff` outside the files listed in this spec shows nothing else.

## Live check (after the review checkpoint, owner-gated)

Not a checklist step. With the owner's Langfuse project keys in the local `.env` and the stack running (started by the owner), send one chat message. Observed result recorded in the final report: one Langfuse trace whose id equals the `ChatTrace.id` (or its documented mapping) returned in the `trace` SSE event, with a span per graph node and model call, model names, token usage and timings present, and no message text, tool data or token anywhere in its inputs, outputs or metadata (checked in the Langfuse UI or API). Then stop the network or set a wrong base URL and confirm a chat still completes and its `ChatTrace` is stored. If the owner does not provide keys, the report says the live behavior was not observed.

**Observed 2026-10-23** (owner's Langfuse Cloud US project, local stack, customer `ana@example.com`, one order question):

- Trace `edb7c8f5-63ef-457d-86d5-b507666e19cf` (route `order`, tool `list_orders`, status `ok`) appeared in Langfuse as `edb7c8f563ef457d86d5b507666e19cf`: one root `LangGraph` span and 19 children (`router`, `order`, `list_orders`, `remember`, `compact`, 5 `ChatAnthropic` generations).
- Root session id `061ea77f-222f-4538-ab32-a282b7014904` and user id `cus_ana` match the stored `ChatTrace` (checked through `GET /observability/traces/:id`).
- Every input and output shown was `"[redacted]"`. Generation metadata held only the five allowlisted keys plus the SDK's own `scope.*` and `resourceAttributes.*`; no `token`, JWT, `customerId` or message text. Model (`claude-haiku-4-5-20251001`), token usage, latency and Langfuse's own cost estimate were present.
- With `LANGFUSE_BASE_URL=http://127.0.0.1:9` the chat still completed (`status: ok`) and trace `aae823c7-709b-418d-b90a-5796de6f4c09` was stored with its 5 calls. Its absence in Langfuse was not checked, and the one-key startup failure was not tried live (covered by `env.spec.ts`).

## Files / areas

- Changed: `package.json`, `package-lock.json`, `apps/orderops-agent/src/env.ts` (+ `env.spec.ts`), `.env.example`, `.env.production.example`, `docker-compose.prod.yml`, `apps/orderops-agent/src/chat/chat.service.ts` (+ spec), the module that provides `ChatService` (where the Langfuse provider is registered), `AGENTS.md`, `README.md`, `docs/deploy.md`.
- New: the masking module and spec under `apps/orderops-agent/src/trace/`, and a small provider/factory file for the handler.
- Untouched: the graph and nodes, `TraceCollector` behavior, `ChatTrace`/`LlmCall` schema, the observability API, the eval harness, the two mock services.

## Data / contracts

- **Trace id**: Langfuse's trace id is derived only from `TraceCollector.id`, the same UUID stored as `ChatTrace.id` and sent in the `trace` SSE event. If Langfuse needs a different format (for example 32 lowercase hex without dashes), the mapping is a fixed, reversible function documented in `AGENTS.md`; no second id is generated.
- **What leaves the server**: observation names and types, the node tree, start and end times, model and provider names, token usage, cost if the package computes it, error status and error type. Inputs and outputs become a fixed placeholder string. Metadata keeps only an explicit allowlist decided in step 3; the caller's JWT never leaves the server.
- **Session and user**: `threadId` and `customerId` may be attached as Langfuse session and user ids only if step 1 shows they are plain fields; they are not secrets (10b already exposes them to viewers), but they are identifiers of real demo users.
- **Enablement**: on when both keys are non-empty; off otherwise, with no handler created and no network call. One key alone is a startup error.
- **Failure semantics**: Langfuse never affects the response, the SSE events, the stored `ChatTrace` or latency beyond creating the handler; flush on shutdown is bounded by the existing timeout and its failure is logged without secrets.

## Testing

Unit specs for the env rules, masking (with fixture secrets that must not appear in the output), and the service wiring (disabled, enabled with a fake handler, throwing handler, flush). The e2e suite runs without keys and must stay green. Run once at the end: `npm run lint`, the three app typechecks, `npm run typecheck:spec`, `npm test`, `npm run test:e2e`, and the prod compose config check. Real delivery to Langfuse is proven only by the owner-gated live check above; without it the report must say the live behavior was not observed.

## Notes for the AI

- Read the docs before coding step 4; do not guess the Langfuse API from memory, and do not enable automatic input/output capture anywhere.
- Mask in one place (the module from step 3) and test it with realistic payload shapes; never rely on callers to avoid sending text.
- `configurable.token` is the caller's JWT; make sure it cannot reach Langfuse through run metadata.
- Keep evals, the mock services and CI keyless; do not add Langfuse keys to GitHub workflows.
- Install with `npx -y npm@11 install`; never edit `package-lock.json` by hand.
- Add no AI attribution to commits; never commit, push or deploy from `/implement`.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":12160,"specSha256":"6b6c30acc3c39fa4232a5725e86bf853a5aac9b3496f80aa7794bcbdbe79d59b","branch":"refs/heads/feature/langfuse-spans","head":"4ccb5ee9620c10743e2e8ecc9b8ef239ac7ff344","baseRef":"refs/heads/master","baseCommit":"ea33c706a23faab3c45cebfd039af1b1c985afe4","sourceTree":"762034af82302196f6e0255255e3e88cb1f00fee","absentOptional":[]} -->

## Independent review

**Status:** passed
**Target commit:** 4ccb5ee9620c10743e2e8ecc9b8ef239ac7ff344
**Base commit:** ea33c706a23faab3c45cebfd039af1b1c985afe4
**Base ref:** master
**Spec hash:** 6b6c30acc3c39fa4232a5725e86bf853a5aac9b3496f80aa7794bcbdbe79d59b
**Prepared by:** claude
**Builder model:** claude-opus-5-5
**Requested reviewer:** claude
**Requested model:** claude-opus-5-5
**Requested execution:** automatic
**Requested at:** 2026-10-23T15:06:30Z
**Workflow:** regular
**Check required:** no
**Reviewer adapter:** claude
**Reviewer model:** claude-opus-5-5
**Reviewer context:** fresh subagent
**Actual execution:** automatic
**Reviewed at:** 2026-10-23T15:10:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** passed
**Check result:** not-required

### Commands

- `git rev-parse HEAD`, `git merge-base master HEAD`, `sha256sum blueprint/context/current-feature.md`, `git status --porcelain`: pass (target, base and spec hash match; only `blueprint/context/review.md` differs)
- `npm run lint`: pass
- `npx tsc -p apps/orderops-agent/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/orders-service/tsconfig.app.json --noEmit`: pass
- `npx tsc -p apps/customers-service/tsconfig.app.json --noEmit`: pass
- `npm run typecheck:spec`: pass
- `npm test`: pass (46 files, 415 tests)
- `npm run test:e2e`: pass (6 files, 72 tests, no Langfuse keys)

### Evidence

- Full delta `ea33c70..4ccb5ee` reviewed (17 files): `trace/langfuse.ts`, `trace/langfuse-mask.ts` (+ spec), `chat/chat.service.ts` (+ spec), `chat/chat.module.ts`, `env.ts` (+ spec), env examples, `docker-compose.prod.yml`, `package.json`/lock, docs.
- Trust boundary checked against the installed `@langfuse/langchain@6.0.2`, `@langfuse/core` and `@langfuse/otel` sources: every attribute the handler writes (`langfuse.observation.input/output`, `langfuse.trace.input/output`, flattened `langfuse.observation.metadata.<key>`, `langfuse.trace.metadata.*`, `prompt.*`, `status_message`) is either redacted, reduced to the error type, allowlisted, or dropped by `ScrubbingSpanProcessor` before the Langfuse processor's `onEnd`; exception events are cleared and `span.status.message` reduced. Attributes added in Langfuse's `onStart` (environment, release, propagated `user.id`/`session.id`) are scrubbed too. The `configurable.token` copy in run metadata is dropped (not allowlisted).
- Span names come from node, tool and model class names only (no `runName`/`withConfig` in `apps/orderops-agent/src`); model parameters are limited by the handler to temperature/max_tokens/top_p/penalties/timeout.
- No HTTP instrumentation is registered, so the global W3C propagator from `provider.register()` adds no headers to calls to the services or model providers.
- Failure isolation: handler constructor is trivial; handler methods catch internally and LangChain does not raise handler errors; `chat.service.spec.ts` proves identical events and stored trace with a handler that throws on every callback. Langfuse is off (`null` provider, no tracer registered) without keys.
- Shutdown: `flushTraces` (trace writes, then `provider.forceFlush()` with errors logged by name only) runs inside `SseConnections.bounded` (5 s `DRAIN_TIMEOUT_MS`); Langfuse's exporter timeout defaults to 5 s and the batch queue is bounded.
- `langfuse-mask.spec.ts` drives a real LangGraph run through the real `CallbackHandler` and real `LangfuseSpanProcessor` (in-memory exporter) and asserts trace id mapping and absence of message, output, token and error text in names, attributes, events and status.
- Spec's owner-gated live check is recorded in the spec (observed 2026-10-23); not re-run here (not required).

### Findings

- None (no new findings; existing F-08, F-19, F-22 are outside this delta and unchanged)

### Remaining risk

- `docker compose -f docker-compose.prod.yml config -q` was not run by the reviewer (needs `.env.production` values; the builder's report covers it).
- Absence of spans in Langfuse during an outage and the one-key startup failure were not observed live (covered by unit specs only, as the spec notes).
- Masking depends on Langfuse's attribute names; a future `@langfuse/*` upgrade that adds new data-bearing attribute keys would be dropped by the allowlist, but a renamed input/output key would also be dropped, so the risk is lost metadata rather than leakage. The real-handler spec should catch regressions on upgrade.
- A single-identifier error string (for example a thrown bare word) would pass `errorType` unchanged; no such throw exists in the graph code.
