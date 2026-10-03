import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  interrupt,
  type LangGraphRunnableConfig,
  messagesStateReducer,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentEvent, ChatRoute } from '../chat/chat.schemas.js';
import type { OrdersClient } from '../chat/orders.client.js';
import type { FaqService } from '../faq/faq.service.js';
import { extractFacts, factsMessages } from '../memory/facts.js';
import type { UserMemoryStore } from '../memory/user-memory.store.js';
import type { RefundStore } from '../refunds/refund.store.js';
import { compactHistory, withSummary } from './compaction.js';
import { runOrderRoute } from './order-route.js';
import { REFUND_REPLIES, runRefundRoute } from './refund-route.js';
import { classifyIntent } from './router.js';

export const OUT_OF_SCOPE_ANSWER =
  'I can only help with your orders and our store policies (returns, shipping, warranty). Is there something about those I can help with?';

/** Only the human message and the final answer of each turn are persisted. */
const AgentState = Annotation.Root({
  message: Annotation<string>(),
  route: Annotation<ChatRoute>(),
  summary: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** Set while a newly stored refund request waits for an operator; reset on every turn. */
  pendingRefund: Annotation<PendingRefund | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
});

type State = typeof AgentState.State;

interface PendingRefund {
  id: string;
  orderId: string;
  amount: string;
}

/** What an operator decision resumes the paused thread with. */
const resumeSchema = z.object({
  refundId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
});

/** Per-request values passed through `config.configurable`; never checkpointed. */
export interface CallerConfig {
  token: string;
  customerId: string;
  thread_id: string;
}

export interface AgentDeps {
  /** Classification-style calls: routing, fact extraction, summarization. */
  cheap: BaseChatModel;
  /** Answers and tool loops: FAQ, order and refund routes. */
  strong: BaseChatModel;
  orders: OrdersClient;
  faq: Pick<FaqService, 'answer'>;
  checkpointer: BaseCheckpointSaver;
  memory: UserMemoryStore;
  refunds: RefundStore;
  /** Clock for the refund window; tests inject a fixed time. */
  now?: () => Date;
}

const logger = new Logger('AgentGraph');

/** Nodes stream `AgentEvent`s through the custom stream writer; the last one is always `final`. */
export function buildAgentGraph({
  cheap,
  strong,
  orders,
  faq,
  checkpointer,
  memory,
  refunds,
  now = () => new Date(),
}: AgentDeps) {
  const emitter = (config: LangGraphRunnableConfig) => (event: AgentEvent) =>
    config.writer?.(event);
  const signalOf = (config: LangGraphRunnableConfig) =>
    config.signal ?? new AbortController().signal;
  const callerOf = (config: LangGraphRunnableConfig) =>
    config.configurable as CallerConfig;
  /** Stored facts; a read failure only costs this turn its long-term context. */
  const factsOf = async (config: LangGraphRunnableConfig) => {
    try {
      return await memory.get(callerOf(config).customerId);
    } catch (error) {
      logger.warn(`memory read failed: ${(error as Error).name}`);
      return [];
    }
  };
  /** Earlier turns only (the new human message is the last one in state), led by facts and summary. */
  const historyOf = async (state: State, config: LangGraphRunnableConfig) => [
    ...factsMessages(await factsOf(config)),
    ...withSummary(state.summary, state.messages.slice(0, -1)),
  ];
  const answered = (answer: string) => ({ messages: [new AIMessage(answer)] });

  return new StateGraph(AgentState)
    .addNode('router', async (state: State, config) => ({
      route: await classifyIntent(
        cheap,
        state.message,
        await historyOf(state, config),
        signalOf(config),
      ),
      pendingRefund: null,
    }))
    .addNode('faq', async (state: State, config) => {
      const answer = await faq.answer(state.message, signalOf(config));
      emitter(config)({ type: 'final', data: { ...answer, route: 'faq' } });
      return answered(answer.answer);
    })
    .addNode('order', async (state: State, config) => {
      const emit = emitter(config);
      const reply = await runOrderRoute({
        model: strong,
        orders,
        message: state.message,
        history: await historyOf(state, config),
        token: callerOf(config).token,
        signal: signalOf(config),
        emit,
      });
      emit({ type: 'final', data: reply });
      return answered(reply.answer);
    })
    .addNode('refund', async (state: State, config) => {
      let pendingRefund: PendingRefund | null = null;
      const emit = (event: AgentEvent) => {
        if (event.type === 'approval_required')
          pendingRefund = {
            id: event.data.refundId,
            orderId: event.data.orderId,
            amount: event.data.amount,
          };
        emitter(config)(event);
      };
      const { token, customerId, thread_id } = callerOf(config);
      const reply = await runRefundRoute({
        model: strong,
        orders,
        refunds,
        message: state.message,
        history: await historyOf(state, config),
        token,
        customerId,
        threadKey: thread_id,
        signal: signalOf(config),
        emit,
        now,
      });
      emit({ type: 'final', data: reply });
      return { ...answered(reply.answer), pendingRefund };
    })
    .addNode('out_of_scope', (_state: State, config) => {
      emitter(config)({
        type: 'final',
        data: {
          answer: OUT_OF_SCOPE_ANSWER,
          orderIds: [],
          route: 'out_of_scope',
        },
      });
      return answered(OUT_OF_SCOPE_ANSWER);
    })
    .addNode('remember', async (state: State, config) => {
      const { customerId } = callerOf(config);
      const added = await extractFacts(
        cheap,
        await factsOf(config),
        state.message,
        signalOf(config),
      );
      if (added.length === 0) return {};
      try {
        await memory.add(customerId, added);
      } catch (error) {
        logger.warn(`memory write failed: ${(error as Error).name}`);
      }
      return {};
    })
    .addNode(
      'compact',
      async (state: State, config) =>
        (await compactHistory(
          cheap,
          state.messages,
          state.summary,
          signalOf(config),
        )) ?? {},
    )
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state: State) => state.route, [
      'faq',
      'order',
      'refund',
      'out_of_scope',
    ])
    .addEdge('faq', 'remember')
    .addEdge('order', 'remember')
    .addEdge('refund', 'remember')
    .addEdge('out_of_scope', 'compact')
    .addEdge('remember', 'compact')
    .addNode('await_approval', (state: State) => {
      const pending = state.pendingRefund;
      if (!pending) return {};
      // The node re-runs from its start on resume, so nothing may happen before interrupt().
      const resumed = interrupt({ refundId: pending.id });
      const { refundId, decision } = resumeSchema.parse(resumed);
      // A decision for another request must never be recorded against this one.
      if (refundId !== pending.id)
        throw new Error('resume does not match the pending refund');
      const text =
        decision === 'approved'
          ? REFUND_REPLIES.approved
          : REFUND_REPLIES.declined;
      return {
        ...answered(text(pending.id, pending.amount, pending.orderId)),
        pendingRefund: null,
      };
    })
    .addConditionalEdges(
      'compact',
      (state: State) => (state.pendingRefund ? 'await_approval' : END),
      ['await_approval', END],
    )
    .addEdge('await_approval', END)
    .compile({ checkpointer });
}
