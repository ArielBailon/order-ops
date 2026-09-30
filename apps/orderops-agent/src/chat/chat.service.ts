import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { OutputParserException } from '@langchain/core/output_parsers';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  CHAT_ERROR_MESSAGES,
  type ChatErrorCode,
  type ChatEvent,
  type FinalAnswer,
  finalAnswerSchema,
  type ToolName,
} from './chat.schemas.js';
import { createOrderTools } from './order-tools.js';
import { OrdersClient } from './orders.client.js';

export const CHAT_MODEL = Symbol('CHAT_MODEL');

export const CHAT_SYSTEM_PROMPT = `You are the support assistant of an online store.
You help the signed-in customer with questions about their own orders: status, shipping, delivery, and contents.
Use the tools to look orders up; never guess order details. The tools only ever return this customer's orders.
If a tool reports "not_found", tell the customer you could not find that order. If it reports "unavailable", say the order system is temporarily unavailable.
If the question is not about the customer's orders, briefly say you can only help with orders.
You cannot take actions, send notifications, or follow up later, so never offer to.
Be concise and friendly.`;

export const FINAL_ANSWER_PROMPT = `Now write your final reply to the customer as structured output.
"answer" is the reply text. "orderIds" lists the ids of the orders the reply is about, and may be empty.`;

const MAX_MODEL_TURNS = 4;
const MAX_STRUCTURED_ATTEMPTS = 2;

class ChatAgentError extends Error {
  constructor(readonly code: ChatErrorCode) {
    super(code);
    this.name = 'ChatAgentError';
  }
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(CHAT_MODEL) private readonly model: BaseChatModel,
    private readonly orders: OrdersClient,
  ) {}

  /** Answers one message; always ends with exactly one `final` or `error` event. */
  async *reply(
    message: string,
    token: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    try {
      const seenOrderIds = new Set<string>();
      const tools = createOrderTools(this.orders, token, seenOrderIds);
      const messages: BaseMessage[] = [
        new SystemMessage(CHAT_SYSTEM_PROMPT),
        new HumanMessage(message),
      ];

      yield* this.runToolLoop(messages, tools, signal);
      const answer = await this.structuredAnswer(messages, signal);
      yield {
        type: 'final',
        data: {
          ...answer,
          orderIds: answer.orderIds.filter((id) => seenOrderIds.has(id)),
        },
      };
    } catch (error) {
      const code = error instanceof ChatAgentError ? error.code : 'agent_error';
      this.logger.warn(`chat failed (${code}): ${(error as Error).name}`);
      yield {
        type: 'error',
        data: { code, message: CHAT_ERROR_MESSAGES[code] },
      };
    }
  }

  private async *runToolLoop(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    if (!this.model.bindTools)
      throw new Error('Chat model does not support tool calling');
    const toolModel = this.model.bindTools(tools);

    for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
      let full: AIMessageChunk | undefined;
      for await (const chunk of await toolModel.stream(messages, { signal })) {
        if (chunk.text) yield { type: 'token', data: { text: chunk.text } };
        full = full ? full.concat(chunk) : chunk;
      }
      if (!full) throw new Error('Chat model returned an empty stream');
      messages.push(full);

      const toolCalls = full.tool_calls ?? [];
      if (toolCalls.length === 0) return;
      for (const call of toolCalls) {
        if (tools.some((t) => t.name === call.name))
          yield {
            type: 'tool_call',
            data: { name: call.name as ToolName, args: call.args },
          };
        messages.push(await this.runTool(tools, call));
      }
    }
    throw new ChatAgentError('agent_error');
  }

  private async runTool(
    tools: StructuredToolInterface[],
    call: ToolCall,
  ): Promise<ToolMessage> {
    const target = tools.find((t) => t.name === call.name);
    let content: string;
    try {
      content = target
        ? String(await target.invoke(call.args))
        : JSON.stringify({ error: 'unknown_tool' });
    } catch {
      content = JSON.stringify({ error: 'invalid_arguments' });
    }
    return new ToolMessage({
      content,
      tool_call_id: call.id ?? '',
      name: call.name,
    });
  }

  private async structuredAnswer(
    messages: BaseMessage[],
    signal: AbortSignal,
  ): Promise<FinalAnswer> {
    const structured = this.model.withStructuredOutput(finalAnswerSchema, {
      name: 'final_answer',
    });
    const input = [...messages, new HumanMessage(FINAL_ANSWER_PROMPT)];

    for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
      try {
        const parsed = finalAnswerSchema.safeParse(
          await structured.invoke(input, { signal }),
        );
        if (parsed.success) return parsed.data;
      } catch (error) {
        if (!(error instanceof OutputParserException)) throw error;
      }
      this.logger.warn(`structured answer invalid (attempt ${attempt})`);
    }
    throw new ChatAgentError('invalid_output');
  }
}
