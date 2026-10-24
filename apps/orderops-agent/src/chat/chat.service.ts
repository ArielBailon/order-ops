import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import { buildAgentGraph, type CallerConfig } from '../agent/agent.graph.js';
import { FaqService } from '../faq/faq.service.js';
import { REFUND_REPLIES } from '../agent/refund-route.js';
import { CHEAP_MODEL, STRONG_MODEL } from '../models/models.module.js';
import { CHECKPOINTER } from '../memory/checkpointer.js';
import { LANGFUSE, type LangfuseTracing } from '../trace/langfuse.js';
import { summarize, TraceCollector } from '../trace/trace-recorder.js';
import {
  TRACE_STORE,
  type TraceRecord,
  type TraceStore,
} from '../trace/trace.store.js';
import {
  type Decision,
  REFUND_STORE,
  type RefundStore,
} from '../refunds/refund.store.js';
import {
  USER_MEMORY,
  type UserMemoryStore,
} from '../memory/user-memory.store.js';
import { ChatAgentError } from './chat.errors.js';
import {
  BUDGET_REPLY,
  DAILY_BUDGET,
  type DailyBudget,
} from './daily-budget.js';
import {
  type AgentEvent,
  CHAT_ERROR_MESSAGES,
  type ChatEvent,
} from './chat.schemas.js';
import { OrdersClient } from './orders.client.js';

export interface ChatTurn {
  message: string;
  token: string;
  customerId: string;
  threadId: string;
}

export class RefundNotPausedError extends Error {
  constructor() {
    super('thread is not paused on this refund request');
    this.name = 'RefundNotPausedError';
  }
}

/** The customer id comes from the verified JWT, so a client can only reach its own threads. */
export const threadKey = (customerId: string, threadId: string) =>
  `${customerId}:${threadId}`;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly graph;
  private readonly pendingTraces = new Set<Promise<void>>();

  constructor(
    @Inject(CHEAP_MODEL) cheap: BaseChatModel,
    @Inject(STRONG_MODEL) strong: BaseChatModel,
    orders: OrdersClient,
    faq: FaqService,
    @Inject(CHECKPOINTER) checkpointer: BaseCheckpointSaver,
    @Inject(USER_MEMORY) memory: UserMemoryStore,
    @Inject(REFUND_STORE) refunds: RefundStore,
    @Inject(TRACE_STORE) private readonly traces: TraceStore,
    // Null when Langfuse is off (no keys); spans are metadata only (see trace/langfuse-mask.ts).
    @Optional()
    @Inject(LANGFUSE)
    private readonly langfuse: LangfuseTracing | null = null,
    // Null when DAILY_BUDGET_USD is unset: no spend query, no fixed reply.
    @Optional()
    @Inject(DAILY_BUDGET)
    private readonly budget: DailyBudget | null = null,
  ) {
    this.graph = buildAgentGraph({
      cheap,
      strong,
      orders,
      faq,
      checkpointer,
      memory,
      refunds,
    });
  }

  /**
   * Records an operator decision in the conversation. Only the pause node runs, so no model
   * call or customer token is needed. A thread paused on this exact request is resumed. A
   * thread that has moved on (the customer wrote again, which cancels the pause) gets the
   * same fixed message appended directly, because the stored row names its thread. A thread
   * paused on another request (a customer can file several in one thread) is refused with
   * `RefundNotPausedError`; callers treat any failure as non-fatal because the stored
   * decision is the source of truth.
   */
  async resumeRefund(
    threadKey: string,
    customerId: string,
    refund: { id: string; orderId: string; amount: string },
    decision: Decision,
  ): Promise<void> {
    const configurable: CallerConfig = {
      token: '',
      customerId,
      thread_id: threadKey,
    };
    const state = await this.graph.getState({ configurable });
    if (state.next.includes('await_approval')) {
      if (state.values.pendingRefund?.id !== refund.id)
        throw new RefundNotPausedError();
      await this.graph.invoke(
        new Command({ resume: { refundId: refund.id, decision } }),
        { configurable },
      );
      return;
    }
    // A thread with no messages never ran. Any other thread is not waiting on an approval:
    // it finished, or its run was cut off before the pause (the client closed the stream
    // after `final`), which leaves a stale `next` that nothing will ever run.
    if (!state.values.messages?.length) throw new RefundNotPausedError();
    const text =
      decision === 'approved'
        ? REFUND_REPLIES.approved
        : REFUND_REPLIES.declined;
    await this.graph.updateState(
      { configurable },
      {
        messages: [
          new AIMessage(text(refund.id, refund.amount, refund.orderId)),
        ],
        pendingRefund: null,
      },
      'await_approval',
    );
  }

  /**
   * Answers one message: exactly one `final` or `error` event, then a `trace` event while
   * the client is still reading.
   */
  async *reply(
    { message, token, customerId, threadId }: ChatTurn,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    // Checked before the graph starts, so a used-up budget costs no model, orders or checkpoint call.
    if (this.budget && (await this.budget.exceeded())) {
      yield* this.budgetReply(customerId, threadId, signal);
      return;
    }
    const configurable: CallerConfig = {
      token,
      customerId,
      thread_id: threadKey(customerId, threadId),
    };
    const collector = new TraceCollector();
    const startedAt = Date.now();
    // Built once, so the `trace` event and the stored row carry the same id and totals.
    let record: TraceRecord | undefined;
    const finish = () =>
      (record ??= collector.toRecord(
        { customerId, threadId, startedAt },
        signal.aborted,
      ));
    try {
      const stream = await this.graph.stream(
        { message, messages: [new HumanMessage(message)] },
        {
          streamMode: 'custom',
          signal,
          configurable,
          callbacks: [
            collector,
            ...(this.langfuse
              ? [
                  this.langfuse.handlerFor(collector.id, {
                    sessionId: threadId,
                    userId: customerId,
                  }),
                ]
              : []),
          ],
        },
      );
      for await (const event of stream as AsyncIterable<AgentEvent>) {
        const out: ChatEvent =
          event.type === 'final'
            ? { type: 'final', data: { ...event.data, threadId } }
            : event;
        collector.note(out);
        yield out;
      }
      const trace = traceEvent(finish());
      if (trace) yield trace;
    } catch (error) {
      const code = error instanceof ChatAgentError ? error.code : 'agent_error';
      this.logger.warn(`chat failed (${code}): ${(error as Error).name}`);
      const out: ChatEvent = {
        type: 'error',
        data: { code, message: CHAT_ERROR_MESSAGES[code] },
      };
      collector.note(out);
      yield out;
      const trace = traceEvent(finish());
      if (trace) yield trace;
    } finally {
      this.storeTrace(finish());
    }
  }

  /**
   * The fixed reply once the daily budget is used up (route `budget`): a normal `final` and
   * `trace`, and a stored trace with no calls. The thread is not touched.
   */
  private async *budgetReply(
    customerId: string,
    threadId: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const collector = new TraceCollector();
    const startedAt = Date.now();
    const final: ChatEvent = {
      type: 'final',
      data: { answer: BUDGET_REPLY, orderIds: [], route: 'budget', threadId },
    };
    collector.note(final);
    let record: TraceRecord | undefined;
    const finish = () =>
      (record ??= collector.toRecord(
        { customerId, threadId, startedAt },
        signal.aborted,
      ));
    try {
      yield final;
      const trace = traceEvent(finish());
      if (trace) yield trace;
    } finally {
      this.storeTrace(finish());
    }
  }

  /**
   * Not awaited: a slow database must not hold the SSE stream open after `final`.
   * Tracked so a shutdown can wait for it before the database is disconnected.
   */
  private storeTrace(record: TraceRecord): void {
    const write = this.recordTrace(record);
    this.pendingTraces.add(write);
    void write.finally(() => this.pendingTraces.delete(write));
  }

  /** Resolves once the trace writes started so far have settled (they never reject). */
  async flushTraces(): Promise<void> {
    await Promise.allSettled(this.pendingTraces);
    // Best-effort, like the trace writes: a Langfuse outage must not block shutdown with an error.
    await this.langfuse?.flush().catch((error: unknown) => {
      this.logger.warn(`langfuse flush failed: ${(error as Error).name}`);
    });
  }

  /** Best-effort: a trace the store cannot write never changes the chat response. */
  private async recordTrace(trace: TraceRecord): Promise<void> {
    try {
      await this.traces.record(trace);
    } catch (error) {
      this.logger.warn(`trace write failed: ${(error as Error).name}`);
    }
  }
}

/** The closing `trace` event, or null for an aborted request (nobody is reading it). */
function traceEvent(record: TraceRecord): ChatEvent | null {
  if (record.status === 'aborted') return null;
  return {
    type: 'trace',
    data: summarize({ ...record, status: record.status }),
  };
}
