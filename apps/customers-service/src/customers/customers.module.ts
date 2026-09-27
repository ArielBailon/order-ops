import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { PrismaModule } from '@app/prisma';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
