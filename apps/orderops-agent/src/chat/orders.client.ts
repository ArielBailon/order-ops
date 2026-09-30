import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z, type ZodType } from 'zod';
import { type Order, orderSchema } from './chat.schemas.js';

export type OrdersError = 'not_found' | 'unavailable';
export type OrdersResult<T> =
  { ok: true; data: T } | { ok: false; error: OrdersError };

const UPSTREAM_TIMEOUT_MS = 5000;

@Injectable()
export class OrdersClient {
  private readonly logger = new Logger(OrdersClient.name);
  private readonly ordersServiceUrl: string;

  constructor(config: ConfigService) {
    this.ordersServiceUrl = config.getOrThrow<string>('ORDERS_SERVICE_URL');
  }

  listOrders(
    token: string,
    signal: AbortSignal,
  ): Promise<OrdersResult<Order[]>> {
    return this.get('/orders', token, signal, z.array(orderSchema));
  }

  getOrder(
    token: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<OrdersResult<Order>> {
    return this.get(
      `/orders/${encodeURIComponent(orderId)}`,
      token,
      signal,
      orderSchema,
    );
  }

  private async get<T>(
    path: string,
    token: string,
    signal: AbortSignal,
    schema: ZodType<T>,
  ): Promise<OrdersResult<T>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.ordersServiceUrl), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]),
      });
    } catch (error) {
      this.logger.warn(`orders-service unreachable: ${(error as Error).name}`);
      return { ok: false, error: 'unavailable' };
    }

    if (response.status === 404) return { ok: false, error: 'not_found' };
    const body = response.ok
      ? schema.safeParse(await response.json().catch(() => null))
      : null;
    if (!body?.success) {
      this.logger.warn(
        `orders-service answered ${response.status} to GET ${path.split('/')[1]}`,
      );
      return { ok: false, error: 'unavailable' };
    }
    return { ok: true, data: body.data };
  }
}
