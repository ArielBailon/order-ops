import type { OrderStatus } from '@app/prisma';
import { z } from 'zod';

export const orderItemsSchema = z.array(
  z.object({
    sku: z.string(),
    name: z.string(),
    quantity: z.number().int().min(1),
    unitPrice: z.string().regex(/^\d+\.\d{2}$/),
  }),
);

export type OrderItem = z.infer<typeof orderItemsSchema>[number];

export interface OrderResponse {
  id: string;
  customerId: string;
  items: OrderItem[];
  total: string;
  status: OrderStatus;
  createdAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
}
