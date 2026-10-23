import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { ChatModule } from '../chat/chat.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';
import { ApprovalsController } from './approvals.controller.js';
import { MyRefundsController } from './my-refunds.controller.js';

@Module({
  imports: [AuthModule, ChatModule, RefundsModule],
  controllers: [ApprovalsController, MyRefundsController],
})
export class ApprovalsModule {}
