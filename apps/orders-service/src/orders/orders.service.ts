import { Injectable } from '@nestjs/common';
import { type Order, PrismaService } from '@app/prisma';
import { type OrderResponse, orderItemsSchema } from './order.schemas.js';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCustomer(customerId: string): Promise<OrderResponse[]> {
    const orders = await this.prisma.order.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map(toOrderResponse);
  }

  async findForCustomer(customerId: string, id: string): Promise<OrderResponse | null> {
    const order = await this.prisma.order.findFirst({ where: { id, customerId } });
    return order ? toOrderResponse(order) : null;
  }
}

export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    customerId: order.customerId,
    items: orderItemsSchema.parse(order.items),
    total: order.total.toFixed(2),
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    shippedAt: order.shippedAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
  };
}
