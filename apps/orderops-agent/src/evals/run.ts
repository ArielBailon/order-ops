import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { buildAgentGraph, type CallerConfig } from '../agent/agent.graph.js';
import { ChatAgentError } from '../chat/chat.errors.js';
import type {
  AgentEvent,
  ReplyRoute,
  RefundSummary,
} from '../chat/chat.schemas.js';
import { FaqService, type PolicySearch } from '../faq/faq.service.js';
import { createFailoverModel } from '../models/failover.js';
import {
  createChatModel,
  type Provider,
  type ProviderEnv,
  type Tier,
} from '../models/providers.js';
import { TraceCollector } from '../trace/trace-recorder.js';
import type { EvalCase } from './dataset.js';
import {
  createFakeOrders,
  InMemoryRefundStore,
  InMemoryUserMemory,
  tokenFor,
} from './fakes.js';
import { CUSTOMER_IDS, NOW } from './fixtures.js';

export const DEFAULT_CASE_TIMEOUT_MS = 120_000;

export interface EvalModels {
  cheap: BaseChatModel;
  strong: BaseChatModel;
}

/**
 * Both tiers pinned to one provider, so a result is attributable. A single-candidate
 * failover wrapper keeps the provider-specific prompt rewriting the real app applies.
 */
export function createEvalModels(
  provider: Provider,
  env: ProviderEnv,
): EvalModels {
  const pinned = (tier: Tier) =>
    createFailoverModel([
      { provider, model: createChatModel(provider, tier, env) },
    ]);
  return { cheap: pinned('cheap'), strong: pinned('strong') };
}

export interface RunnerDeps {
  models: EvalModels;
  policies: PolicySearch;
  /** Per-case limit; a case that exceeds it is recorded as a run error. */
  timeoutMs?: number;
}

/** Records what each tool returned, i.e. what the model saw (run-time only, never persisted). */
class ToolResultCollector extends BaseCallbackHandler {
  name = 'tool-result-collector';
  awaitHandlers = true;
  readonly results: string[] = [];

  handleToolEnd(output: unknown): void {
    const content =
      typeof output === 'object' && output !== null && 'content' in output
        ? (output as { content: unknown }).content
        : output;
    this.results.push(
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
}

export interface ToolCallRun {
  name: string;
  orderId?: string;
}

/** What one case produced. Route, answer, refund and approval come from the last turn. */
export interface CaseRun {
  id: string;
  /** Error code or name when the run threw or timed out; the rest is then partial. */
  error: string | null;
  route: ReplyRoute | null;
  /** Tool calls over all turns, in call order. */
  toolCalls: ToolCallRun[];
  /** What the tools returned, in call order; input for the answer-quality judge. */
  toolResults: string[];
  answer: string;
  refund: RefundSummary | null;
  approvalRequired: boolean;
  /** Every turn ended with exactly one `final` and no `error` event. */
  streamOk: boolean;
  events: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Null when any call used a model without a price. */
  costUsd: number | null;
  latencyMs: number;
}

/**
 * Runs one case on a fresh thread with fresh in-memory stores, driving the real graph the
 * way `ChatService.reply` does. Never throws: a failure is recorded in `error`.
 */
export async function runCase(
  testCase: EvalCase,
  { models, policies, timeoutMs = DEFAULT_CASE_TIMEOUT_MS }: RunnerDeps,
): Promise<CaseRun> {
  const customerId = CUSTOMER_IDS[testCase.customer];
  const graph = buildAgentGraph({
    cheap: models.cheap,
    strong: models.strong,
    orders: createFakeOrders(),
    faq: new FaqService(models.strong, policies),
    checkpointer: new MemorySaver(),
    memory: new InMemoryUserMemory(),
    refunds: new InMemoryRefundStore(),
    now: () => NOW,
  });
  const configurable: CallerConfig = {
    token: tokenFor(testCase.customer),
    customerId,
    thread_id: `${customerId}:eval-${testCase.id}`,
  };
  const collector = new TraceCollector();
  const toolResults = new ToolResultCollector();
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = Date.now();

  const run: CaseRun = {
    id: testCase.id,
    error: null,
    route: null,
    toolCalls: [],
    toolResults: [],
    answer: '',
    refund: null,
    approvalRequired: false,
    streamOk: true,
    events: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };

  try {
    for (const message of testCase.turns) {
      let finals = 0;
      run.route = null;
      run.answer = '';
      run.refund = null;
      run.approvalRequired = false;
      const stream = await graph.stream(
        { message, messages: [new HumanMessage(message)] },
        {
          streamMode: 'custom',
          signal,
          configurable,
          callbacks: [collector, toolResults],
        },
      );
      for await (const event of stream as AsyncIterable<AgentEvent>) {
        run.events++;
        if (event.type === 'tool_call') {
          const { orderId } = event.data.args;
          run.toolCalls.push({
            name: event.data.name,
            ...(typeof orderId === 'string' && { orderId }),
          });
        } else if (event.type === 'approval_required') {
          run.approvalRequired = true;
        } else if (event.type === 'final') {
          finals++;
          run.route = event.data.route;
          run.answer = event.data.answer;
          run.refund = event.data.refund ?? null;
        } else if (event.type === 'error') {
          run.streamOk = false;
        }
      }
      if (finals !== 1) run.streamOk = false;
    }
  } catch (error) {
    run.error = error instanceof ChatAgentError ? error.code : errorName(error);
    run.streamOk = false;
  }

  run.toolResults = toolResults.results;
  for (const call of collector.calls) {
    run.llmCalls++;
    run.inputTokens += call.inputTokens;
    run.outputTokens += call.outputTokens;
    run.cachedTokens += call.cacheReadTokens;
    run.costUsd =
      run.costUsd === null || call.costUsd === null
        ? null
        : run.costUsd + call.costUsd;
  }
  run.latencyMs = Date.now() - startedAt;
  return run;
}

/**
 * True once the estimated agent cost of `runs` exceeds `maxCostUsd`. An unpriced model
 * (null cost) also counts: the cap cannot be enforced, so the run stops.
 */
export function costCapReached(runs: CaseRun[], maxCostUsd: number): boolean {
  let total = 0;
  for (const run of runs) {
    if (run.costUsd === null) return true;
    total += run.costUsd;
  }
  return total > maxCostUsd;
}

/**
 * Cases run one after another; `onCase` reports progress. `shouldStop` is checked after
 * each case, and the cases not yet run are then skipped.
 */
export async function runCases(
  cases: EvalCase[],
  deps: RunnerDeps,
  onCase?: (run: CaseRun, index: number) => void,
  shouldStop?: (runs: CaseRun[]) => boolean,
): Promise<CaseRun[]> {
  const runs: CaseRun[] = [];
  for (const testCase of cases) {
    const run = await runCase(testCase, deps);
    runs.push(run);
    onCase?.(run, runs.length - 1);
    if (shouldStop?.(runs)) break;
  }
  return runs;
}

/** Only the error class: provider messages are not recorded in result files. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
