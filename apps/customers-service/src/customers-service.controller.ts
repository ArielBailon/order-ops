import { Controller, Get } from '@nestjs/common';
import { CustomersServiceService } from './customers-service.service.js';

@Controller()
export class CustomersServiceController {
  constructor(private readonly customersServiceService: CustomersServiceService) {}

  @Get()
  getHello(): string {
    return this.customersServiceService.getHello();
  }
}
