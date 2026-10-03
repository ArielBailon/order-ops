import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, type BaseCheckpointSaver } from '@langchain/langgraph';
import { buildAgentGraph, type CallerConfig } from '../agent/agent.graph.js';
import { FaqService } from '../faq/faq.service.js';
import { REFUND_REPLIES } from '../agent/refund-route.js';
import { CHEAP_MODEL, STRONG_MODEL } from '../models/models.module.js';
import { CHECKPOINTER } from '../memory/checkpointer.js';
import { TraceCollector } from '../trace/trace-recorder.js';
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

  constructor(
    @Inject(CHEAP_MODEL) cheap: BaseChatModel,
    @Inject(STRONG_MODEL) strong: BaseChatModel,
    orders: OrdersClient,
    faq: FaqService,
    @Inject(CHECKPOINTER) checkpointer: BaseCheckpointSaver,
    @Inject(USER_MEMORY) memory: UserMemoryStore,
    @Inject(REFUND_STORE) refunds: RefundStore,
    @Inject(TRACE_STORE) private readonly traces: TraceStore,
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

  /** Answers one message; always ends with exactly one `final` or `error` event. */
  async *reply(
    { message, token, customerId, threadId }: ChatTurn,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const configurable: CallerConfig = {
      token,
      customerId,
      thread_id: threadKey(customerId, threadId),
    };
    const collector = new TraceCollector();
    const startedAt = Date.now();
    try {
      const stream = await this.graph.stream(
        { message, messages: [new HumanMessage(message)] },
        {
          streamMode: 'custom',
          signal,
          configurable,
          callbacks: [collector],
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
    } catch (error) {
      const code = error instanceof ChatAgentError ? error.code : 'agent_error';
      this.logger.warn(`chat failed (${code}): ${(error as Error).name}`);
      const out: ChatEvent = {
        type: 'error',
        data: { code, message: CHAT_ERROR_MESSAGES[code] },
      };
      collector.note(out);
      yield out;
    } finally {
      await this.recordTrace(
        collector.toRecord({ customerId, threadId, startedAt }, signal.aborted),
      );
    }
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
