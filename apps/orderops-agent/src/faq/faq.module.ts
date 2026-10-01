import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatModelModule } from '../chat/chat-model.module.js';
import { FaqService } from './faq.service.js';
import {
  createEmbeddings,
  createPolicyStore,
  EMBEDDINGS,
  POLICY_STORE,
} from './policy-store.js';

@Module({
  imports: [ChatModelModule],
  providers: [
    FaqService,
    {
      provide: EMBEDDINGS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createEmbeddings(config.getOrThrow<string>('OPENAI_API_KEY')),
    },
    {
      provide: POLICY_STORE,
      inject: [EMBEDDINGS, ConfigService],
      useFactory: (
        embeddings: ReturnType<typeof createEmbeddings>,
        config: ConfigService,
      ) =>
        createPolicyStore(
          embeddings,
          config.getOrThrow<string>('DATABASE_URL'),
        ),
    },
  ],
  exports: [FaqService],
})
export class FaqModule {}
