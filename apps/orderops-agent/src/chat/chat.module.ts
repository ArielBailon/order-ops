import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { FaqModule } from '../faq/faq.module.js';
import { ChatModelModule } from './chat-model.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { OrdersClient } from './orders.client.js';

@Module({
  imports: [AuthModule, ChatModelModule, FaqModule],
  controllers: [ChatController],
  providers: [ChatService, OrdersClient],
})
export class ChatModule {}
