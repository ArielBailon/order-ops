import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { buildAgentGraph, type CallerConfig } from '../agent/agent.graph.js';
import { FaqService } from '../faq/faq.service.js';
import { CHECKPOINTER } from '../memory/checkpointer.js';
import {
  USER_MEMORY,
  type UserMemoryStore,
} from '../memory/user-memory.store.js';
import { CHAT_MODEL } from './chat-model.token.js';
import { ChatAgentError } from './chat.errors.js';
import {
  type AgentEvent,
  CHAT_ERROR_MESSAGES,
  type ChatEvent,
} from './chat.schemas.js';
import { OrdersClient } from './orders.client.js';

export { CHAT_MODEL };

export interface ChatTurn {
  message: string;
  token: string;
  customerId: string;
  threadId: string;
}

/** The customer id comes from the verified JWT, so a client can only reach its own threads. */
export const threadKey = (customerId: string, threadId: string) =>
  `${customerId}:${threadId}`;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly graph;

  constructor(
    @Inject(CHAT_MODEL) model: BaseChatModel,
    orders: OrdersClient,
    faq: FaqService,
    @Inject(CHECKPOINTER) checkpointer: BaseCheckpointSaver,
    @Inject(USER_MEMORY) memory: UserMemoryStore,
  ) {
    this.graph = buildAgentGraph({
      model,
      orders,
      faq,
      checkpointer,
      memory,
    });
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
    try {
      const stream = await this.graph.stream(
        { message, messages: [new HumanMessage(message)] },
        { streamMode: 'custom', signal, configurable },
      );
      for await (const event of stream as AsyncIterable<AgentEvent>)
        yield event.type === 'final'
          ? { type: 'final', data: { ...event.data, threadId } }
          : event;
    } catch (error) {
      const code = error instanceof ChatAgentError ? error.code : 'agent_error';
      this.logger.warn(`chat failed (${code}): ${(error as Error).name}`);
      yield {
        type: 'error',
        data: { code, message: CHAT_ERROR_MESSAGES[code] },
      };
    }
  }
}
