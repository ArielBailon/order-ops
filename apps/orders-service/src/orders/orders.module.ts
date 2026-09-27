import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { PrismaModule } from '@app/prisma';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
