import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import type { AgentEvent } from '../chat/chat.schemas.js';
import type { OrdersClient } from '../chat/orders.client.js';
import { runOrderRoute } from './order-route.js';

const toolCall = new AIMessageChunk({
  content: '',
  tool_call_chunks: [
    {
      name: 'get_order',
      args: '{"orderId":"ORD-1003"}',
      id: 'call_1',
      index: 0,
    },
  ],
});
const prose = new AIMessageChunk({ content: 'Looked it up.' });

/** Records the options of every `bindTools` call; each stream consumes the next scripted turn. */
const fakeModel = (turns: AIMessageChunk[]) => {
  const bound: unknown[] = [];
  const model = {
    bindTools: (_tools: unknown, options?: unknown) => {
      bound.push(options);
      return {
        stream: async () =>
          (async function* () {
            const turn = turns.shift();
            if (!turn) throw new Error('unexpected model turn');
            yield turn;
          })(),
      };
    },
    withStructuredOutput: () => ({
      invoke: async () => ({
        answer: 'Total is 199.00',
        orderIds: ['ORD-1003'],
      }),
    }),
  } as unknown as BaseChatModel;
  return { model, bound };
};

describe('runOrderRoute', () => {
  const orders = {
    getOrder: vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'ORD-1003', total: '199.00' },
    }),
    listOrders: vi.fn(),
  } as unknown as OrdersClient;
  const run = (model: BaseChatModel, emit = vi.fn<(e: AgentEvent) => void>()) =>
    runOrderRoute({
      model,
      orders,
      message: 'And what is its total?',
      history: [],
      token: 'token',
      signal: new AbortController().signal,
      emit,
    });

  it('requires a tool call on the first turn only', async () => {
    const { model, bound } = fakeModel([toolCall, prose]);
    const emit = vi.fn<(e: AgentEvent) => void>();

    const result = await run(model, emit);

    // Bound once up front, then again to force the first turn.
    expect(bound).toContainEqual({ tool_choice: 'any' });
    expect(bound.filter((o) => o !== undefined)).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'tool_call',
      data: { name: 'get_order', args: { orderId: 'ORD-1003' } },
    });
    expect(result).toMatchObject({ route: 'order', orderIds: ['ORD-1003'] });
  });
});
