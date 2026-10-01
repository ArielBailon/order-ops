import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PrismaModule } from '@app/prisma';
import { CHECKPOINTER, createCheckpointer } from './checkpointer.js';
import { PrismaUserMemoryStore, USER_MEMORY } from './user-memory.store.js';

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: CHECKPOINTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createCheckpointer(config.getOrThrow<string>('DATABASE_URL')),
    },
    { provide: USER_MEMORY, useClass: PrismaUserMemoryStore },
  ],
  exports: [CHECKPOINTER, USER_MEMORY],
})
export class MemoryModule implements OnApplicationShutdown {
  constructor(
    @Inject(CHECKPOINTER) private readonly saver: BaseCheckpointSaver,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.saver instanceof PostgresSaver) await this.saver.end();
  }
}
