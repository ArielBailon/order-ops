import { ChatAnthropic } from '@langchain/anthropic';
import { ChatBedrockConverse } from '@langchain/aws';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../env.js';

export type Provider = 'anthropic' | 'openai' | 'bedrock';
/** `cheap` for classification-style calls, `strong` for answers and tool loops. */
export type Tier = 'cheap' | 'strong';

/** Failover order: the first enabled provider is tried first. */
export const PROVIDER_ORDER: readonly Provider[] = [
  'anthropic',
  'openai',
  'bedrock',
];

export const MODEL_IDS: Record<Provider, Record<Tier, string>> = {
  anthropic: { cheap: 'claude-haiku-4-5-20251001', strong: 'claude-sonnet-5' },
  openai: { cheap: 'gpt-4o-mini', strong: 'gpt-4o' },
  bedrock: {
    cheap: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    strong: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
};

export type ProviderEnv = Pick<
  Env,
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'AWS_REGION'
  | 'AWS_ACCESS_KEY_ID'
  | 'AWS_SECRET_ACCESS_KEY'
>;

/** Providers with credentials, in failover order. Bedrock needs `AWS_REGION`. */
export function enabledProviders(env: ProviderEnv): Provider[] {
  return PROVIDER_ORDER.filter(
    (provider) => provider !== 'bedrock' || env.AWS_REGION !== undefined,
  );
}

export function createChatModel(
  provider: Provider,
  tier: Tier,
  env: ProviderEnv,
): BaseChatModel {
  const model = MODEL_IDS[provider][tier];
  switch (provider) {
    case 'anthropic':
      return new ChatAnthropic({ model, apiKey: env.ANTHROPIC_API_KEY });
    case 'openai':
      return new ChatOpenAI({ model, apiKey: env.OPENAI_API_KEY });
    case 'bedrock':
      return new ChatBedrockConverse({
        model,
        region: env.AWS_REGION,
        // Without an explicit key pair the AWS default credential chain applies.
        ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      });
  }
}
