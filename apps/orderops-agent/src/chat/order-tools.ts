import { type StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Order, ToolName } from './chat.schemas.js';
import type { OrdersClient, OrdersResult } from './orders.client.js';

/**
 * Tools bound to one request's token. Ownership is enforced by orders-service
 * from that token, so no tool accepts a customer id. Every order a tool returns
 * is recorded in `seenOrderIds` to ground the final answer.
 */
export function createOrderTools(
  client: OrdersClient,
  token: string,
  seenOrderIds: Set<string>,
): StructuredToolInterface[] {
  const toToolOutput = <T extends Order | Order[]>(
    result: OrdersResult<T>,
  ): string => {
    if (!result.ok) return JSON.stringify({ error: result.error });
    for (const order of [result.data].flat()) seenOrderIds.add(order.id);
    return JSON.stringify(result.data);
  };

  return [
    tool(async () => toToolOutput(await client.listOrders(token)), {
      name: 'list_orders' satisfies ToolName,
      description: "List the current customer's orders, newest first.",
      schema: z.object({}),
    }),
    tool(
      async ({ orderId }) =>
        toToolOutput(await client.getOrder(token, orderId)),
      {
        name: 'get_order' satisfies ToolName,
        description:
          'Get one of the current customer\'s orders by its id (for example "ORD-1001").',
        schema: z.object({ orderId: z.string().min(1).max(100) }),
      },
    ),
  ];
}
