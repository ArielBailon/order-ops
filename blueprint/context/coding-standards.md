# Coding Standards

> Tuned by `/onboard` for the NestJS monorepo + LangChain.js/LangGraph.js stack.
> Edit freely; items marked TODO are conventions the code has not established yet.

## TypeScript

- Strict mode enabled
- No `any` types - use proper typing or `unknown`
- Define interfaces for all props, API responses, and data models
- Use type inference where obvious, explicit types where helpful

## Runtime and modules

- TypeScript (strict), Node.js, ESM (`"type": "module"`, `module: nodenext`)
- Relative imports use the `.js` extension (`./app.module.js`), as nodenext requires
- Package manager: npm (`package-lock.json`)
- Build: Nest CLI with the rspack builder (transpile only; typecheck separately with `tsc`)

## NestJS monorepo

- Nest CLI native monorepo. Apps live in `apps/<app>/src`; default project is
  `orderops-agent` (gateway + agent). `orders-service` and `customers-service`
  are mock microservices the agent calls over HTTP.
- Shared code goes in a Nest library (`nest g library <name>` -> `libs/<name>`)
  only once two apps actually need it. Do not import across `apps/` directly.
- One Nest module per feature (`<feature>/<feature>.module.ts`, controller,
  service). Controllers stay thin: parse, delegate, map errors to HTTP.
- Configuration through `@nestjs/config`; read env in one place, never
  `process.env` scattered through services.
- Ports: gateway 3000 (`PORT`), orders-service 3001 (`ORDERS_SERVICE_PORT`),
  customers-service 3002 (`CUSTOMERS_SERVICE_PORT`). The internal services bind
  `127.0.0.1`; the gateway reaches them through `ORDERS_SERVICE_URL` and
  `CUSTOMERS_SERVICE_URL`. Each app validates its env in `src/env.ts`.

## Agent code (LangChain.js / LangGraph.js)

- The graph (state, nodes, conditional edges) lives in the gateway app; nodes are
  plain functions or injectable services, not controllers.
- Tools are LangChain tools with Zod input schemas. Tools that hit a service
  call it over HTTP with the caller's token; never pass a client-supplied user
  id to a tool.
- Business rules (refund limits, eligibility, ownership) are enforced in code,
  never only in the prompt.
- Structured model output uses `withStructuredOutput` with a Zod schema and a
  bounded retry, never unbounded loops.
- Prompts live next to the node that uses them, as exported constants.
- Model access goes through the provider layer in
  `apps/orderops-agent/src/models/`: inject `CHEAP_MODEL` (routing, memory
  extraction, summaries) or `STRONG_MODEL` (answers, tool loops); never build a
  chat model elsewhere.

## Validation and API boundaries

- Validate every inbound request body, query, and model/tool output with Zod.
- Auth: JWT on the gateway; scope every user-owned lookup by the authenticated
  identity. Services validate the propagated token themselves.
- SSE event types are part of the API contract: `token`, `tool_call`,
  `approval_required`, `final`, `error`.

## Database

- PostgreSQL + pgvector via `docker compose`. Prisma for app data; Prisma 7
  config is `prisma7.config.ts`, generated client output `libs/prisma/src/generated`, imported as `@app/prisma`.
- Always use `prisma migrate dev` for schema changes (not `db push`).
- LangGraph checkpoints and vector embeddings use their own tables managed by
  their libraries, not Prisma models.
- All apps share one Postgres database and one Prisma schema (`prisma/schema.prisma`).

## Error handling

- Throw Nest HTTP exceptions (or map domain errors to them) at the controller
  edge; services throw typed domain errors.
- Agent failures fall back to a deterministic response, never a raw stack trace
  or provider error to the client.
- Never log secrets, tokens, or full prompts containing user data.

## File organization

- Feature code: `apps/<app>/src/<feature>/` (module, controller, service, dto/schemas)
- Zod schemas and types: next to the feature (`<feature>.schemas.ts`)
- Unit tests next to source (`*.spec.ts`); e2e tests in `apps/<app>/test/*.e2e-spec.ts`

## Naming

- Files: kebab-case with Nest suffixes (`orders.service.ts`, `orders.controller.ts`)
- Classes and types: PascalCase (no `I` prefix)
- Functions and variables: camelCase
- Constants: SCREAMING_SNAKE_CASE

## Testing

The blueprint installs no test runner; testing is opt-in at the project level,
because the overlay can't know your stack. Adding unit testing is an explicit
setup task the AI can do through the normal workflow, either as a build-plan item
or with `/tests`. The setup should choose the stack-native runner, wire the
scripts or commands, add a small example test, and update the Commands section
of `AGENTS.md`.

When `AGENTS.md` declares a `Verify` command, treat it as the umbrella automated
gate. It combines only the checks this project actually has, in this order when
available: typecheck, tests, then build. The command does not enable an absent
test runner or replace focused evidence. It gives local work and optional CI one
exact command to run. `/ci` owns Verify and CI setup. `/tests` adds the real test
command to Verify when it already exists, but never creates CI only because
testing was configured.

**The opt-in switch is one signal: a `test` command in the Commands section of
`AGENTS.md`.** Declare one and **tests become a gate for logic-bearing steps**,
not an optional extra; leave it out and the loop verifies logic with the evidence
it already uses (run it, a screenshot, the build). Adding the runner is itself a
deliberate step, never a silent mid-step install. This is the single definition
of the switch; the skills and `ai-interaction.md` only point back here.

- **What to test (the scope rule):** pure logic where a wrong answer is possible -
  parsers, validators, Zod schemas, business rules, graph routing functions,
  tool input/output mapping, service methods. These have
  assertable inputs and outputs and real edge cases (empty, missing, malformed).
- **What not to test:** real LLM calls and integration-level surfaces that need a
  live provider. Verify those with API/SSE output, e2e tests with mocked models,
  or evals, not brittle unit tests.
- **The gate (when a runner is configured):** a build step that adds in-scope logic
  must ship a passing test in the same reviewable diff. The project's test command
  must be green before the step is approved, before any checkpoint commit, and
  before `/complete` merges. UI and integration-only steps are exempt and ride on
  screenshot plus build evidence.
- **When it's named:** the `/feature` spec's Testing section predicts the coverage,
  `/implement` writes the test with the step, and if a step surfaces logic the spec
  didn't foresee, add a focused test then.
- An empty suite should fail, not pass, so "no tests ran" never looks like "passed".
- Test files live next to source files (for example `orders.service.spec.ts`).
- Run them via the project's test command (see Commands in `AGENTS.md`), not a
  hardcoded tool name.

Stack binding: Vitest is configured (`npm test` for `*.spec.ts`,
`npm run test:e2e` for `*.e2e-spec.ts`), so the test gate is active. Use
`vi.mock()` for external dependencies (LLM providers, HTTP services, Prisma) and
`vi.useFakeTimers()` for time-dependent logic. Unit tests must never call a real
LLM provider; model behavior is measured by the eval suite (Build plan item 7).

## Browser Verification

For UI and integration behavior, prefer real browser evidence over reading the
code and assuming it works.

- Browser automation is separately opt-in through `/tests browser`. That setup
  reuses a compatible runner or prefers Playwright for supported projects, then
  documents the exact command as `Browser tests` in `AGENTS.md`.
- When `Browser tests` is declared, add focused coverage for stable behavioral
  done-whens when it is proportionate, and run the documented command during
  `/check`. Do not assume it proves visual fidelity, real authenticated-profile
  behavior, browser chrome, or another claim the test does not observe.
- If no Browser tests command is declared, do not add a runner silently in the
  middle of an unrelated feature. Use the available dev server, browser
  screenshots, build output, API output, or manual evidence instead.
- Browser tests are not part of the default Verify command or CI unless the user
  separately chooses that slower gate.
- Browser evidence is especially important for flows that click, type, submit,
  navigate, download files, render complex layouts, or depend on client-side
  state.

## Code Quality

- No commented-out code unless specified
- No unused imports or variables
- Keep functions under 50 lines when possible

## Comments

Write code that explains itself; comment only what the code cannot say.
Over-commenting is a common AI tell, so resist it.

- Comment the **why**, not the **what**. Delete any comment that restates the code.
- No banner/header blocks, section dividers, or step-by-step narration of obvious
  code. A file does not need a comment announcing each region.
- A comment earns its place only when it captures something the code can't: a
  non-obvious decision, a gotcha or workaround, why a value is what it is, or a
  link to a spec or issue.
- Prefer self-documenting names and small functions over explanatory comments.
- Keep doc comments minimal: a one-line purpose on an exported type or function is
  plenty; don't write JSDoc that just repeats the signature.
- When in doubt, leave the comment out.

## Writing

- No em dashes (U+2014) in generated content: docs, comments, commit messages,
  READMEs, specs. They read as AI-generated.
- Use a hyphen for `term - description` separators; rephrase prose with commas,
  parentheses, or a colon. Avoid en dashes and the ellipsis character too.
