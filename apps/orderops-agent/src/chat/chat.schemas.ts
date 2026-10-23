import { z } from 'zod';

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  threadId: z.uuid().optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const finalAnswerSchema = z.object({
  answer: z.string().min(1).describe('The reply to show the customer'),
  orderIds: z
    .array(z.string())
    .describe(
      'Ids of the orders the reply is about, exactly as the tools returned them',
    ),
});

export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

export const chatRouteSchema = z.enum([
  'faq',
  'order',
  'refund',
  'out_of_scope',
]);

export type ChatRoute = z.infer<typeof chatRouteSchema>;

export const routedIntentSchema = z.object({
  intent: chatRouteSchema.describe('Which route should handle the message'),
});

/** Set on refund-route replies when a request was stored or an open one was reused. */
export interface RefundSummary {
  id: string;
  status: 'pending_approval' | 'auto_rejected';
}

export type FinalReply = FinalAnswer & {
  route: ChatRoute;
  refund?: RefundSummary;
};

export type ToolName = 'list_orders' | 'get_order';

export type ChatErrorCode = 'agent_error' | 'invalid_output' | 'shutting_down';

/** Sent once, right before `final`, when a new refund request waits for an operator. */
export interface ApprovalRequired {
  refundId: string;
  orderId: string;
  /** Money string with two decimals, for example "89.90". */
  amount: string;
}

/** Events graph nodes stream; the service adds the thread id to `final`. */
export type AgentEvent =
  | { type: 'token'; data: { text: string } }
  | { type: 'approval_required'; data: ApprovalRequired }
  | {
      type: 'tool_call';
      data: { name: ToolName; args: Record<string, unknown> };
    }
  | { type: 'final'; data: FinalReply }
  | { type: 'error'; data: { code: ChatErrorCode; message: string } };

/**
 * Closes every reply that is still being read: metadata about the request, never message
 * text. `id` is the stored `ChatTrace` id. `costUsd` sums the priced calls (six decimals),
 * null when no call had a price; `unpriced` counts the calls left out.
 */
export interface TraceSummary {
  id: string;
  route: ChatRoute | null;
  tools: string[];
  /** Provider of the last completed model call, null when none completed. */
  provider: string | null;
  /** Model of the last completed model call, null when none completed. */
  model: string | null;
  failovers: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUsd: string | null;
  unpriced: number;
  latencyMs: number;
  status: 'ok' | 'error';
}

/**
 * SSE events streamed by POST /chat. `approval_required` precedes `final` when a refund
 * waits for an operator; `trace` follows `final` or `error`.
 */
export type ChatEvent =
  | Exclude<AgentEvent, { type: 'final' }>
  | { type: 'final'; data: FinalReply & { threadId: string } }
  | { type: 'trace'; data: TraceSummary };

export const CHAT_ERROR_MESSAGES: Record<ChatErrorCode, string> = {
  agent_error: 'The assistant could not answer right now. Please try again.',
  invalid_output:
    'The assistant could not produce a valid answer. Please try again.',
  shutting_down: 'The assistant is restarting. Please send your message again.',
};

export function formatSseEvent({ type, data }: ChatEvent): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const money = z.string().regex(/^\d+\.\d{2}$/);

/** Mirrors the orders-service response; parsed at the gateway because it is upstream input. */
export const orderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      quantity: z.number().int().min(1),
      unitPrice: money,
    }),
  ),
  total: money,
  status: z.enum([
    'pending',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
  ]),
  createdAt: z.iso.datetime(),
  shippedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
});

export type Order = z.infer<typeof orderSchema>;
