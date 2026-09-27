import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { type AuthenticatedCustomer, CurrentCustomer, JwtAuthGuard } from '@app/auth';
import { OrdersService } from './orders.service.js';
import type { OrderResponse } from './order.schemas.js';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@CurrentCustomer() { customerId }: AuthenticatedCustomer): Promise<OrderResponse[]> {
    return this.orders.listForCustomer(customerId);
  }

  @Get(':id')
  async findOne(
    @CurrentCustomer() { customerId }: AuthenticatedCustomer,
    @Param('id') id: string,
  ): Promise<OrderResponse> {
    const order = await this.orders.findForCustomer(customerId, id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }
}
