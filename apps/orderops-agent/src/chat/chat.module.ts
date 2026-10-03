import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { FaqModule } from '../faq/faq.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ModelsModule } from '../models/models.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { OrdersClient } from './orders.client.js';

@Module({
  imports: [AuthModule, FaqModule, MemoryModule, ModelsModule, RefundsModule],
  controllers: [ChatController],
  providers: [ChatService, OrdersClient],
  exports: [ChatService],
})
export class ChatModule {}
