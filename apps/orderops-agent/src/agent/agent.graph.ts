import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  Annotation,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { ChatEvent, ChatRoute } from '../chat/chat.schemas.js';
import type { OrdersClient } from '../chat/orders.client.js';
import type { FaqService } from '../faq/faq.service.js';
import { runOrderRoute } from './order-route.js';
import { classifyIntent } from './router.js';

export const OUT_OF_SCOPE_ANSWER =
  'I can only help with your orders and our store policies (returns, shipping, warranty). Is there something about those I can help with?';

const AgentState = Annotation.Root({
  message: Annotation<string>(),
  token: Annotation<string>(),
  route: Annotation<ChatRoute>(),
});

type State = typeof AgentState.State;

export interface AgentDeps {
  model: BaseChatModel;
  orders: OrdersClient;
  faq: Pick<FaqService, 'answer'>;
}

/** Nodes stream `ChatEvent`s through the custom stream writer; the last one is always `final`. */
export function buildAgentGraph({ model, orders, faq }: AgentDeps) {
  const emitter = (config: LangGraphRunnableConfig) => (event: ChatEvent) =>
    config.writer?.(event);
  const signalOf = (config: LangGraphRunnableConfig) =>
    config.signal ?? new AbortController().signal;

  return new StateGraph(AgentState)
    .addNode('router', async (state: State, config) => ({
      route: await classifyIntent(model, state.message, signalOf(config)),
    }))
    .addNode('faq', async (state: State, config) => {
      const answer = await faq.answer(state.message, signalOf(config));
      emitter(config)({ type: 'final', data: { ...answer, route: 'faq' } });
      return {};
    })
    .addNode('order', async (state: State, config) => {
      const emit = emitter(config);
      emit({
        type: 'final',
        data: await runOrderRoute({
          model,
          orders,
          message: state.message,
          token: state.token,
          signal: signalOf(config),
          emit,
        }),
      });
      return {};
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
      return {};
    })
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state: State) => state.route, [
      'faq',
      'order',
      'out_of_scope',
    ])
    .addEdge('faq', END)
    .addEdge('order', END)
    .addEdge('out_of_scope', END)
    .compile();
}
