import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { PrismaRefundStore, REFUND_STORE } from './refund.store.js';

@Module({
  imports: [PrismaModule],
  providers: [{ provide: REFUND_STORE, useClass: PrismaRefundStore }],
  exports: [REFUND_STORE],
})
export class RefundsModule {}
