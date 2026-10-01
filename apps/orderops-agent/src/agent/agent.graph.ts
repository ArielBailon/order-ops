import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  type LangGraphRunnableConfig,
  messagesStateReducer,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { Logger } from '@nestjs/common';
import type { AgentEvent, ChatRoute } from '../chat/chat.schemas.js';
import type { OrdersClient } from '../chat/orders.client.js';
import type { FaqService } from '../faq/faq.service.js';
import { extractFacts, factsMessages, mergeFacts } from '../memory/facts.js';
import type { UserMemoryStore } from '../memory/user-memory.store.js';
import { compactHistory, withSummary } from './compaction.js';
import { runOrderRoute } from './order-route.js';
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
});

type State = typeof AgentState.State;

/** Per-request values passed through `config.configurable`; never checkpointed. */
export interface CallerConfig {
  token: string;
  customerId: string;
  thread_id: string;
}

export interface AgentDeps {
  model: BaseChatModel;
  orders: OrdersClient;
  faq: Pick<FaqService, 'answer'>;
  checkpointer: BaseCheckpointSaver;
  memory: UserMemoryStore;
}

const logger = new Logger('AgentGraph');

/** Nodes stream `AgentEvent`s through the custom stream writer; the last one is always `final`. */
export function buildAgentGraph({
  model,
  orders,
  faq,
  checkpointer,
  memory,
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
        model,
        state.message,
        await historyOf(state, config),
        signalOf(config),
      ),
    }))
    .addNode('faq', async (state: State, config) => {
      const answer = await faq.answer(state.message, signalOf(config));
      emitter(config)({ type: 'final', data: { ...answer, route: 'faq' } });
      return answered(answer.answer);
    })
    .addNode('order', async (state: State, config) => {
      const emit = emitter(config);
      const reply = await runOrderRoute({
        model,
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
        model,
        await factsOf(config),
        state.message,
        signalOf(config),
      );
      if (added.length === 0) return {};
      try {
        await memory.replace(
          customerId,
          mergeFacts(await memory.get(customerId), added),
        );
      } catch (error) {
        logger.warn(`memory write failed: ${(error as Error).name}`);
      }
      return {};
    })
    .addNode(
      'compact',
      async (state: State, config) =>
        (await compactHistory(
          model,
          state.messages,
          state.summary,
          signalOf(config),
        )) ?? {},
    )
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state: State) => state.route, [
      'faq',
      'order',
      'out_of_scope',
    ])
    .addEdge('faq', 'remember')
    .addEdge('order', 'remember')
    .addEdge('out_of_scope', 'compact')
    .addEdge('remember', 'compact')
    .addEdge('compact', END)
    .compile({ checkpointer });
}
