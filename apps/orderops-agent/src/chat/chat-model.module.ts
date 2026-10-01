import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { CHAT_MODEL } from './chat-model.token.js';

// Single construction point until the provider layer (build plan item 5).
const CHAT_MODEL_ID = 'claude-sonnet-5';

@Module({
  providers: [
    {
      provide: CHAT_MODEL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ChatAnthropic({
          model: CHAT_MODEL_ID,
          apiKey: config.getOrThrow<string>('ANTHROPIC_API_KEY'),
        }),
    },
  ],
  exports: [CHAT_MODEL],
})
export class ChatModelModule {}
