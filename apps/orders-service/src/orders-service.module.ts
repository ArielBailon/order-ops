import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), OrdersModule],
})
export class OrdersServiceModule {}
