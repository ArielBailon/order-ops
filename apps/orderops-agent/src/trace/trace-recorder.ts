import { randomUUID } from 'node:crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGeneration, LLMResult } from '@langchain/core/outputs';
import type {
  ChatEvent,
  ChatRoute,
  TraceSummary,
} from '../chat/chat.schemas.js';
import { costUsd, usageOf } from '../models/pricing.js';
import { MODEL_IDS, type Provider, type Tier } from '../models/providers.js';
import type { LlmCallRecord, TraceRecord, TraceStatus } from './trace.store.js';

/** Provider and tier of a known model id; unknown ids are still recorded, without a tier. */
function describeModel(
  modelId: string,
  lsProvider: unknown,
): { provider: string; tier: Tier | 'unknown' } {
  for (const provider of Object.keys(MODEL_IDS) as Provider[])
    for (const tier of ['cheap', 'strong'] as const)
      if (MODEL_IDS[provider][tier] === modelId) return { provider, tier };
  return {
    provider: typeof lsProvider === 'string' ? lsProvider : 'unknown',
    tier: 'unknown',
  };
}

/**
 * Collects one request's trace: model calls come from LangChain callbacks (attach it as
 * `callbacks` on the graph run), route and tool names from the SSE events the service
 * yields. Holds metadata only; it never reads prompt or reply text.
 */
export class TraceCollector extends BaseCallbackHandler {
  name = 'trace-collector';
  // Handlers are synchronous and cheap; running them inline keeps tests deterministic.
  awaitHandlers = true;

  /** Generated before the request runs so the stored row and the `trace` event share it. */
  readonly id = randomUUID();
  readonly calls: LlmCallRecord[] = [];
  private readonly tools: string[] = [];
  private failovers = 0;
  /** Provider of the last call that failed, until the next call completes. */
  private failedProvider: string | null = null;
  private route: ChatRoute | null = null;
  private sawError = false;
  private readonly started = new Map<
    string,
    { at: number; model: string; provider: unknown }
  >();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.started.set(runId, {
      at: this.now(),
      model: String(metadata?.ls_model_name ?? ''),
      provider: metadata?.ls_provider,
    });
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const start = this.started.get(runId);
    this.started.delete(runId);
    const message = (output.generations[0]?.[0] as ChatGeneration | undefined)
      ?.message;
    const modelId =
      start?.model ||
      String(
        (message?.response_metadata as { model_name?: string } | undefined)
          ?.model_name ?? 'unknown',
      );
    const usage = usageOf(
      (message as { usage_metadata?: Parameters<typeof usageOf>[0] })
        ?.usage_metadata,
    );
    const described = describeModel(modelId, start?.provider);
    // A failed call answered by another provider is a failover; a retry on the same one is not.
    if (
      this.failedProvider !== null &&
      described.provider !== 'unknown' &&
      described.provider !== this.failedProvider
    )
      this.failovers++;
    this.failedProvider = null;
    this.calls.push({
      ...described,
      model: modelId,
      ...usage,
      latencyMs: start ? Math.max(0, this.now() - start.at) : 0,
      costUsd: costUsd(modelId, usage),
    });
  }

  handleLLMError(_error: unknown, runId: string): void {
    const start = this.started.get(runId);
    this.started.delete(runId);
    this.failedProvider = start
      ? describeModel(start.model, start.provider).provider
      : 'unknown';
  }

  /** Feeds an event the service is about to yield. */
  note(event: ChatEvent): void {
    if (event.type === 'final') this.route = event.data.route;
    else if (event.type === 'tool_call') this.tools.push(event.data.name);
    else if (event.type === 'error') this.sawError = true;
  }

  toRecord(
    ctx: { customerId: string; threadId: string; startedAt: number },
    aborted: boolean,
  ): TraceRecord {
    // A client abort surfaces as an error event too, but the abort is the real cause.
    const status: TraceStatus = aborted
      ? 'aborted'
      : this.sawError
        ? 'error'
        : 'ok';
    return {
      id: this.id,
      customerId: ctx.customerId,
      threadId: ctx.threadId,
      route: this.route,
      tools: [...this.tools],
      status,
      latencyMs: Math.max(0, this.now() - ctx.startedAt),
      failovers: this.failovers,
      calls: [...this.calls],
    };
  }
}

/** The `trace` event data for a finished request: totals of its recorded calls, no text. */
export function summarize(
  record: TraceRecord & { status: 'ok' | 'error' },
): TraceSummary {
  const sum = (pick: (call: LlmCallRecord) => number) =>
    record.calls.reduce((total, call) => total + pick(call), 0);
  const priced = record.calls.filter((call) => call.costUsd !== null);
  return {
    id: record.id,
    route: record.route,
    tools: record.tools,
    provider: record.calls.at(-1)?.provider ?? null,
    failovers: record.failovers,
    tokens: {
      input: sum((c) => c.inputTokens),
      output: sum((c) => c.outputTokens),
      cacheRead: sum((c) => c.cacheReadTokens),
      cacheWrite: sum((c) => c.cacheWriteTokens),
    },
    costUsd: priced.length
      ? priced.reduce((total, c) => total + (c.costUsd ?? 0), 0).toFixed(6)
      : null,
    unpriced: record.calls.length - priced.length,
    latencyMs: record.latencyMs,
    status: record.status,
  };
}
