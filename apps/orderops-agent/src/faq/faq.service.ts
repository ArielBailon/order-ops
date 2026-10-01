import { Inject, Injectable } from '@nestjs/common';
import type { Document } from '@langchain/core/documents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { CHAT_MODEL } from '../chat/chat-model.token.js';
import { type FinalAnswer, finalAnswerSchema } from '../chat/chat.schemas.js';
import { invokeStructured } from '../chat/structured-output.js';
import { POLICY_STORE } from './policy-store.js';

export interface PolicySearch {
  similaritySearch(query: string, k: number): Promise<Document[]>;
}

export const FAQ_TOP_K = 4;

export const FAQ_SYSTEM_PROMPT = `You answer customer questions about the store's policies (returns, shipping, warranty).
Answer only from the policy excerpts you are given. If they do not contain the answer, say you do not have that information and suggest contacting support.
Never invent windows, prices, or conditions. Be concise and friendly.`;

export const NO_POLICY_ANSWER =
  "I don't have that information in our store policies. Please contact support for help.";

const faqAnswerSchema = finalAnswerSchema.pick({ answer: true });

@Injectable()
export class FaqService {
  constructor(
    @Inject(CHAT_MODEL) private readonly model: BaseChatModel,
    @Inject(POLICY_STORE) private readonly policies: PolicySearch,
  ) {}

  async answer(message: string, signal: AbortSignal): Promise<FinalAnswer> {
    const chunks = await this.policies.similaritySearch(message, FAQ_TOP_K);
    if (chunks.length === 0) return { answer: NO_POLICY_ANSWER, orderIds: [] };

    const excerpts = chunks
      .map(
        (c) =>
          `[${c.metadata.source} / ${c.metadata.section}]\n${c.pageContent}`,
      )
      .join('\n\n');
    const { answer } = await invokeStructured(
      this.model,
      faqAnswerSchema,
      'faq_answer',
      [
        new SystemMessage(FAQ_SYSTEM_PROMPT),
        new HumanMessage(
          `Policy excerpts:\n${excerpts}\n\nCustomer question: ${message}`,
        ),
      ],
      signal,
    );
    return { answer, orderIds: [] };
  }
}
