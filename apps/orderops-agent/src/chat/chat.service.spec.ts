import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessageChunk,
  type BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import type { ChatEvent } from './chat.schemas.js';
import { ChatService } from './chat.service.js';
import { ORDER_FIXTURE } from './order.fixture.js';
import type { FaqService } from '../faq/faq.service.js';
import type { OrdersClient } from './orders.client.js';

type Turn = AIMessageChunk[];

const text = (value: string) => new AIMessageChunk({ content: value });
const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}`,
) =>
  new AIMessageChunk({
    content: '',
    tool_call_chunks: [
      {
        type: 'tool_call_chunk',
        name,
        args: JSON.stringify(args),
        id,
        index: 0,
      },
    ],
  });

/** Scripted stand-in for the chat model: one chunk list per turn, one result per structured call. */
class FakeChatModel {
  readonly turnInputs: BaseMessage[][] = [];
  readonly structuredInputs: BaseMessage[][] = [];

  constructor(
    private readonly turns: Turn[],
    private readonly structured: unknown[] = [
      { answer: 'Your kettle has shipped.', orderIds: ['ord_1001'] },
    ],
    private readonly routerResults: unknown[] = [{ intent: 'order' }],
  ) {}

  bindTools() {
    return {
      stream: async (messages: BaseMessage[]) => {
        this.turnInputs.push([...messages]);
        const turn = this.turns.shift();
        if (!turn) throw new Error('unexpected model turn');
        return (async function* () {
          yield* turn;
        })();
      },
    };
  }

  withStructuredOutput(_schema: unknown, options?: { name?: string }) {
    const isRouter = options?.name === 'route_message';
    const queue = isRouter ? this.routerResults : this.structured;
    return {
      invoke: async (messages: BaseMessage[]) => {
        if (!isRouter) this.structuredInputs.push(messages);
        const result = queue.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }
}

describe('ChatService', () => {
  const orders = { listOrders: vi.fn(), getOrder: vi.fn() };
  const faq = { answer: vi.fn() };
  const signal = new AbortController().signal;

  const run = async (
    model: FakeChatModel,
    message = 'where is my order?',
    requestSignal = signal,
  ) => {
    const service = new ChatService(
      model as unknown as BaseChatModel,
      orders as unknown as OrdersClient,
      faq as unknown as FaqService,
    );
    const events: ChatEvent[] = [];
    for await (const event of service.reply(message, 'tok', requestSignal))
      events.push(event);
    return events;
  };

  const toolResults = (model: FakeChatModel) =>
    model.turnInputs
      .at(-1)!
      .filter((m): m is ToolMessage => m instanceof ToolMessage)
      .map((m) => m.content);

  beforeEach(() => {
    faq.answer.mockReset();
    orders.listOrders
      .mockReset()
      .mockResolvedValue({ ok: true, data: [ORDER_FIXTURE] });
    orders.getOrder
      .mockReset()
      .mockResolvedValue({ ok: true, data: ORDER_FIXTURE });
  });

  it('calls a tool with the caller token, streams the answer, then emits final', async () => {
    const model = new FakeChatModel([
      [toolCall('get_order', { orderId: 'ord_1001' })],
      [text('Your '), text('kettle shipped.')],
    ]);

    const events = await run(model);

    expect(events).toEqual([
      {
        type: 'tool_call',
        data: { name: 'get_order', args: { orderId: 'ord_1001' } },
      },
      { type: 'token', data: { text: 'Your ' } },
      { type: 'token', data: { text: 'kettle shipped.' } },
      {
        type: 'final',
        data: {
          answer: 'Your kettle has shipped.',
          orderIds: ['ord_1001'],
          route: 'order',
        },
      },
    ]);
    expect(orders.getOrder).toHaveBeenCalledWith(
      'tok',
      'ord_1001',
      expect.any(AbortSignal),
    );
    expect(toolResults(model)).toEqual([JSON.stringify(ORDER_FIXTURE)]);
    expect(model.structuredInputs[0].at(-1)?.content).toContain('final reply');
  });

  it('answers directly without tools and drops ungrounded order ids', async () => {
    const model = new FakeChatModel(
      [[text('I can only help with orders.')]],
      [{ answer: 'I can only help with orders.', orderIds: ['ord_9999'] }],
    );

    const events = await run(model, 'tell me a joke');

    expect(events.at(-1)).toEqual({
      type: 'final',
      data: {
        answer: 'I can only help with orders.',
        orderIds: [],
        route: 'order',
      },
    });
    expect(orders.listOrders).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', { ok: false, error: 'not_found' }],
    ['unavailable', { ok: false, error: 'unavailable' }],
  ])('passes a %s tool result to the model', async (error, result) => {
    orders.getOrder.mockResolvedValue(result);
    const model = new FakeChatModel(
      [[toolCall('get_order', { orderId: 'ord_x' })], [text('Sorry.')]],
      [{ answer: 'Sorry.', orderIds: ['ord_x'] }],
    );

    const events = await run(model);

    expect(toolResults(model)).toEqual([JSON.stringify({ error })]);
    expect(events.at(-1)).toEqual({
      type: 'final',
      data: { answer: 'Sorry.', orderIds: [], route: 'order' },
    });
  });

  it('lists orders and reports invalid tool arguments back to the model', async () => {
    const model = new FakeChatModel([
      [toolCall('list_orders', {}, 'c1')],
      [toolCall('get_order', { orderId: '' }, 'c2')],
      [text('Done.')],
    ]);

    const events = await run(model);

    expect(orders.listOrders).toHaveBeenCalledWith(
      'tok',
      expect.any(AbortSignal),
    );
    expect(orders.getOrder).not.toHaveBeenCalled();
    expect(toolResults(model)).toEqual([
      JSON.stringify([ORDER_FIXTURE]),
      JSON.stringify({ error: 'invalid_arguments' }),
    ]);
    expect(events.at(-1)?.type).toBe('final');
  });

  it('hides an unknown tool name from clients and tells the model', async () => {
    const model = new FakeChatModel([
      [toolCall('delete_everything', {})],
      [text('Sorry.')],
    ]);

    const events = await run(model);

    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(toolResults(model)).toEqual([
      JSON.stringify({ error: 'unknown_tool' }),
    ]);
    expect(events.at(-1)?.type).toBe('final');
  });

  it('stops the loop when the client disconnects mid-run', async () => {
    const abort = new AbortController();
    orders.listOrders.mockImplementation(async () => {
      abort.abort();
      return { ok: true, data: [ORDER_FIXTURE] };
    });
    const model = new FakeChatModel([
      [toolCall('list_orders', {})],
      [text('never streamed')],
    ]);

    const events = await run(model, 'where is my order?', abort.signal);

    expect(model.turnInputs).toHaveLength(1);
    expect(events.filter((e) => e.type === 'token')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('error');
    expect(
      events.filter((e) => e.type === 'error' || e.type === 'final'),
    ).toHaveLength(1);
  });

  it('stops with agent_error after the turn limit', async () => {
    const model = new FakeChatModel(
      Array.from({ length: 4 }, () => [toolCall('list_orders', {})]),
    );

    const events = await run(model);

    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(4);
    expect(events.at(-1)).toEqual({
      type: 'error',
      data: {
        code: 'agent_error',
        message: 'The assistant could not answer right now. Please try again.',
      },
    });
  });

  it('retries an invalid structured answer once', async () => {
    const model = new FakeChatModel(
      [[text('Hi.')]],
      [new OutputParserException('bad json'), { answer: 'Hi.', orderIds: [] }],
    );

    const events = await run(model);

    expect(model.structuredInputs).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: 'final',
      data: { answer: 'Hi.', orderIds: [], route: 'order' },
    });
  });

  it('emits invalid_output after two invalid structured answers', async () => {
    const model = new FakeChatModel(
      [[text('Hi.')]],
      [{ answer: '' }, new OutputParserException('bad json')],
    );

    const events = await run(model);

    expect(events.at(-1)).toEqual({
      type: 'error',
      data: {
        code: 'invalid_output',
        message:
          'The assistant could not produce a valid answer. Please try again.',
      },
    });
  });

  describe('routing', () => {
    it('answers an FAQ message from the FAQ route without the tool model', async () => {
      faq.answer.mockResolvedValue({
        answer: 'Returns take 30 days.',
        orderIds: [],
      });
      const model = new FakeChatModel([], [], [{ intent: 'faq' }]);

      const events = await run(model, 'what is your return policy?');

      expect(faq.answer).toHaveBeenCalledWith(
        'what is your return policy?',
        expect.anything(),
      );
      expect(model.turnInputs).toHaveLength(0);
      expect(orders.listOrders).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          type: 'final',
          data: {
            answer: 'Returns take 30 days.',
            orderIds: [],
            route: 'faq',
          },
        },
      ]);
    });

    it('refuses an out-of-scope message with no other model or service call', async () => {
      const model = new FakeChatModel([], [], [{ intent: 'out_of_scope' }]);

      const events = await run(model, 'write me a poem');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'final',
        data: { orderIds: [], route: 'out_of_scope' },
      });
      expect(model.turnInputs).toHaveLength(0);
      expect(model.structuredInputs).toHaveLength(0);
      expect(faq.answer).not.toHaveBeenCalled();
    });

    it('retries an invalid router answer once', async () => {
      faq.answer.mockResolvedValue({ answer: 'ok', orderIds: [] });
      const model = new FakeChatModel(
        [],
        [],
        [{ intent: 'refund' }, { intent: 'faq' }],
      );

      const events = await run(model);

      expect(events.at(-1)).toMatchObject({
        type: 'final',
        data: { route: 'faq' },
      });
    });

    it('emits invalid_output when the router never returns a valid intent', async () => {
      const model = new FakeChatModel(
        [],
        [],
        [{ intent: 'x' }, { intent: 'y' }],
      );

      const events = await run(model);

      expect(events).toEqual([
        {
          type: 'error',
          data: {
            code: 'invalid_output',
            message:
              'The assistant could not produce a valid answer. Please try again.',
          },
        },
      ]);
    });

    it('maps an FAQ route failure to one generic error', async () => {
      faq.answer.mockRejectedValue(new Error('embeddings down'));
      const model = new FakeChatModel([], [], [{ intent: 'faq' }]);

      const events = await run(model);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        data: { code: 'agent_error' },
      });
    });
  });

  it.each([
    ['during the tool loop', () => new FakeChatModel([])],
    [
      'during the structured answer',
      () =>
        new FakeChatModel(
          [[text('Hi.')]],
          [new Error('overloaded: secret detail')],
        ),
    ],
  ])('maps a model failure %s to one generic error', async (_label, build) => {
    const events = await run(build());

    expect(
      events.filter((e) => e.type === 'error' || e.type === 'final'),
    ).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: 'error',
      data: {
        code: 'agent_error',
        message: 'The assistant could not answer right now. Please try again.',
      },
    });
  });
});
