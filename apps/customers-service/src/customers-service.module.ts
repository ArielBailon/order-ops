import { Module } from '@nestjs/common';
import { CustomersServiceController } from './customers-service.controller.js';
import { CustomersServiceService } from './customers-service.service.js';

@Module({
  imports: [],
  controllers: [CustomersServiceController],
  providers: [CustomersServiceService],
})
export class CustomersServiceModule {}
