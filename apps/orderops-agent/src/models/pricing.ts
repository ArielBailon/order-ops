import type { UsageMetadata } from '@langchain/core/messages';
import { MODEL_IDS } from './providers.js';

/** Token counts for one model call. `inputTokens` includes the cached tokens (LangChain's convention). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const anthropic = (input: number, output: number): Price => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite: input * 1.25,
});
const openai = (input: number, output: number): Price => ({
  input,
  output,
  cacheRead: input * 0.5,
  // OpenAI has no separate cache write charge.
  cacheWrite: input,
});

/** List prices; cost is an estimate, not a bill. Keyed by the ids in `MODEL_IDS`. */
export const PRICES: Record<string, Price> = {
  [MODEL_IDS.anthropic.cheap]: anthropic(1, 5),
  [MODEL_IDS.anthropic.strong]: anthropic(3, 15),
  [MODEL_IDS.openai.cheap]: openai(0.15, 0.6),
  [MODEL_IDS.openai.strong]: openai(2.5, 10),
  [MODEL_IDS.bedrock.cheap]: anthropic(1, 5),
  [MODEL_IDS.bedrock.strong]: anthropic(3, 15),
};

export function usageOf(usage: UsageMetadata | undefined): Usage {
  const details = usage?.input_token_details;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: details?.cache_read ?? 0,
    cacheWriteTokens: details?.cache_creation ?? 0,
  };
}

/** USD for one call, or null when the model has no price (never guessed). */
export function costUsd(modelId: string, usage: Usage): number | null {
  const price = PRICES[modelId];
  if (!price) return null;
  const uncached = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  return (
    (uncached * price.input +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
