import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Env } from '../env.js';
import { createFailoverModel } from './failover.js';
import {
  createChatModel,
  enabledProviders,
  type ProviderEnv,
  type Tier,
} from './providers.js';

export const CHEAP_MODEL = Symbol('CHEAP_MODEL');
export const STRONG_MODEL = Symbol('STRONG_MODEL');

const tierProvider = (token: symbol, tier: Tier) => ({
  provide: token,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): BaseChatModel => {
    const env: ProviderEnv = {
      ANTHROPIC_API_KEY: config.getOrThrow('ANTHROPIC_API_KEY'),
      OPENAI_API_KEY: config.getOrThrow('OPENAI_API_KEY'),
      AWS_REGION: config.get('AWS_REGION') || undefined,
      AWS_ACCESS_KEY_ID: config.get('AWS_ACCESS_KEY_ID') || undefined,
      AWS_SECRET_ACCESS_KEY: config.get('AWS_SECRET_ACCESS_KEY') || undefined,
    };
    return createFailoverModel(
      enabledProviders(env).map((provider) => ({
        provider,
        model: createChatModel(provider, tier, env),
      })),
    );
  },
});

/** The provider layer: `cheap` for classification-style calls, `strong` for answers and tool loops. */
@Module({
  providers: [
    tierProvider(CHEAP_MODEL, 'cheap'),
    tierProvider(STRONG_MODEL, 'strong'),
  ],
  exports: [CHEAP_MODEL, STRONG_MODEL],
})
export class ModelsModule {}
