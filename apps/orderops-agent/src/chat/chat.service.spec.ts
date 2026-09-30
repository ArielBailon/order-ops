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

  withStructuredOutput() {
    return {
      invoke: async (messages: BaseMessage[]) => {
        this.structuredInputs.push(messages);
        const result = this.structured.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }
}

describe('ChatService', () => {
  const orders = { listOrders: vi.fn(), getOrder: vi.fn() };
  const signal = new AbortController().signal;

  const run = async (model: FakeChatModel, message = 'where is my order?') => {
    const service = new ChatService(
      model as unknown as BaseChatModel,
      orders as unknown as OrdersClient,
    );
    const events: ChatEvent[] = [];
    for await (const event of service.reply(message, 'tok', signal))
      events.push(event);
    return events;
  };

  const toolResults = (model: FakeChatModel) =>
    model.turnInputs
      .at(-1)!
      .filter((m): m is ToolMessage => m instanceof ToolMessage)
      .map((m) => m.content);

  beforeEach(() => {
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
        data: { answer: 'Your kettle has shipped.', orderIds: ['ord_1001'] },
      },
    ]);
    expect(orders.getOrder).toHaveBeenCalledWith('tok', 'ord_1001');
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
      data: { answer: 'I can only help with orders.', orderIds: [] },
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
      data: { answer: 'Sorry.', orderIds: [] },
    });
  });

  it('lists orders and reports invalid tool arguments back to the model', async () => {
    const model = new FakeChatModel([
      [toolCall('list_orders', {}, 'c1')],
      [toolCall('get_order', { orderId: '' }, 'c2')],
      [text('Done.')],
    ]);

    const events = await run(model);

    expect(orders.listOrders).toHaveBeenCalledWith('tok');
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
      data: { answer: 'Hi.', orderIds: [] },
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
