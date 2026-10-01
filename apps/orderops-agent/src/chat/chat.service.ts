import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildAgentGraph } from '../agent/agent.graph.js';
import { FaqService } from '../faq/faq.service.js';
import { CHAT_MODEL } from './chat-model.token.js';
import { ChatAgentError } from './chat.errors.js';
import { CHAT_ERROR_MESSAGES, type ChatEvent } from './chat.schemas.js';
import { OrdersClient } from './orders.client.js';

export { CHAT_MODEL };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly graph;

  constructor(
    @Inject(CHAT_MODEL) model: BaseChatModel,
    orders: OrdersClient,
    faq: FaqService,
  ) {
    this.graph = buildAgentGraph({ model, orders, faq });
  }

  /** Answers one message; always ends with exactly one `final` or `error` event. */
  async *reply(
    message: string,
    token: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    try {
      const stream = await this.graph.stream(
        { message, token },
        { streamMode: 'custom', signal },
      );
      for await (const event of stream) yield event as ChatEvent;
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
