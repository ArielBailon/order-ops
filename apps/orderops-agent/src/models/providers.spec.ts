import { ChatAnthropic } from '@langchain/anthropic';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import {
  createChatModel,
  enabledProviders,
  MODEL_IDS,
  type Provider,
  type ProviderEnv,
} from './providers.js';

const env: ProviderEnv = {
  ANTHROPIC_API_KEY: 'a',
  OPENAI_API_KEY: 'o',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
};

describe('createChatModel', () => {
  it.each([
    ['anthropic', ChatAnthropic],
    ['openai', ChatOpenAI],
    ['bedrock', ChatBedrockConverse],
  ] as const)('builds %s models for both tiers', (provider, Class) => {
    for (const tier of ['cheap', 'strong'] as const) {
      const model = createChatModel(provider, tier, env);
      expect(model).toBeInstanceOf(Class);
      expect((model as unknown as { model: string }).model).toBe(
        MODEL_IDS[provider][tier],
      );
    }
  });

  it('uses a cheaper model than the strong tier for every provider', () => {
    for (const provider of Object.keys(MODEL_IDS) as Provider[])
      expect(MODEL_IDS[provider].cheap).not.toBe(MODEL_IDS[provider].strong);
  });
});

describe('enabledProviders', () => {
  it('lists providers in failover order', () => {
    expect(enabledProviders(env)).toEqual(['anthropic', 'openai', 'bedrock']);
  });

  it('omits Bedrock when AWS_REGION is unset', () => {
    expect(enabledProviders({ ...env, AWS_REGION: undefined })).toEqual([
      'anthropic',
      'openai',
    ]);
  });
});
