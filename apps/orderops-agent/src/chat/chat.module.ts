import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '@app/auth';
import { FaqModule } from '../faq/faq.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ModelsModule } from '../models/models.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';
import { LANGFUSE, langfuseFromEnv } from '../trace/langfuse.js';
import { TraceModule } from '../trace/trace.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { OrdersClient } from './orders.client.js';
import { SseConnections } from './sse-connections.js';

@Module({
  imports: [
    AuthModule,
    FaqModule,
    MemoryModule,
    ModelsModule,
    RefundsModule,
    TraceModule,
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    OrdersClient,
    SseConnections,
    {
      provide: LANGFUSE,
      // Null without keys: no handler, no tracer provider, no network.
      useFactory: (config: ConfigService) =>
        langfuseFromEnv({
          LANGFUSE_PUBLIC_KEY: config.get<string>('LANGFUSE_PUBLIC_KEY'),
          LANGFUSE_SECRET_KEY: config.get<string>('LANGFUSE_SECRET_KEY'),
          LANGFUSE_BASE_URL: config.getOrThrow<string>('LANGFUSE_BASE_URL'),
        }),
      inject: [ConfigService],
    },
  ],
  exports: [ChatService],
})
export class ChatModule {}
