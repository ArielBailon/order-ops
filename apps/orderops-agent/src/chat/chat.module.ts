import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { AuthModule } from '@app/auth';
import { ChatController } from './chat.controller.js';
import { CHAT_MODEL, ChatService } from './chat.service.js';
import { OrdersClient } from './orders.client.js';

// Single construction point until the provider layer (build plan item 5).
const CHAT_MODEL_ID = 'claude-sonnet-5';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    OrdersClient,
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
})
export class ChatModule {}
