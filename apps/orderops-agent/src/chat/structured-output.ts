import { Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import type { z } from 'zod';
import { ChatAgentError } from './chat.errors.js';

const MAX_STRUCTURED_ATTEMPTS = 2;
const logger = new Logger('StructuredOutput');

/** Asks the model for schema-valid output, retrying once; `invalid_output` when it never complies. */
export async function invokeStructured<T extends z.ZodType>(
  model: BaseChatModel,
  schema: T,
  name: string,
  input: BaseMessage[],
  signal: AbortSignal,
): Promise<z.infer<T>> {
  const structured = model.withStructuredOutput(schema, { name });

  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    try {
      const parsed = schema.safeParse(
        await structured.invoke(input, { signal }),
      );
      if (parsed.success) return parsed.data;
    } catch (error) {
      if (!(error instanceof OutputParserException)) throw error;
    }
    logger.warn(`structured output "${name}" invalid (attempt ${attempt})`);
  }
  throw new ChatAgentError('invalid_output');
}
