import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  ToolMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import {
  ensureConfig,
  getCallbackManagerForConfig,
} from '@langchain/core/runnables';
import { MemorySaver } from '@langchain/langgraph';
import type { ChatEvent } from './chat.schemas.js';
import { REFUND_REPLIES } from '../agent/refund-route.js';
import {
  type ChatTurn,
  ChatService,
  RefundNotPausedError,
  threadKey,
} from './chat.service.js';
import { BUDGET_REPLY, type DailyBudget } from './daily-budget.js';
import { ORDER_FIXTURE } from './order.fixture.js';
import type { FaqService } from '../faq/faq.service.js';
import type { RefundStore } from '../refunds/refund.store.js';
import type { OrdersClient } from './orders.client.js';
import type { LangfuseTracing } from '../trace/langfuse.js';
import type { TraceRecord } from '../trace/trace.store.js';

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
  /** When set, every model call reports this usage through the ambient LangChain callbacks. */
  usage?: UsageMetadata;
  readonly turnInputs: BaseMessage[][] = [];
  readonly structuredInputs: BaseMessage[][] = [];
  readonly routerInputs: BaseMessage[][] = [];
  readonly factInputs: BaseMessage[][] = [];

  constructor(
    private readonly turns: Turn[],
    private readonly structured: unknown[] = [
      { answer: 'Your kettle has shipped.', orderIds: ['ord_1001'] },
    ],
    private readonly routerResults: unknown[] = [{ intent: 'order' }],
    private readonly factResults: unknown[] = [],
  ) {}

  /** Mimics a chat model run: start and end callbacks go to the handlers of the running graph. */
  private async emit() {
    if (!this.usage) return;
    const parent = await getCallbackManagerForConfig(ensureConfig());
    // Real chat models add their identity to the callback metadata like this.
    const manager = await CallbackManager.configure(
      parent,
      undefined,
      undefined,
      undefined,
      { ls_model_name: 'claude-sonnet-5', ls_provider: 'anthropic' },
    );
    const [run] = await manager!.handleChatModelStart(
      { lc: 1, type: 'not_implemented', id: ['fake'] },
      [[]],
    );
    const message = new AIMessage({ content: '', usage_metadata: this.usage });
    await run.handleLLMEnd({ generations: [[{ text: '', message }]] } as never);
  }

  bindTools() {
    return {
      stream: async (messages: BaseMessage[]) => {
        await this.emit();
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
    if (options?.name === 'remember_facts')
      return {
        invoke: async (messages: BaseMessage[]) => {
          await this.emit();
          this.factInputs.push(messages);
          const result = this.factResults.shift() ?? { facts: [] };
          if (result instanceof Error) throw result;
          return result;
        },
      };
    const isRouter = options?.name === 'route_message';
    const queue = isRouter ? this.routerResults : this.structured;
    return {
      invoke: async (messages: BaseMessage[]) => {
        await this.emit();
        (isRouter ? this.routerInputs : this.structuredInputs).push(messages);
        const result = queue.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }
}

const CUSTOMER = 'cus_ana';
const THREAD = '3f2b8c1e-9d4a-4b7e-8a51-0c6d2e9f7a10';

describe('ChatService', () => {
  let saver: MemorySaver;
  const orders = { listOrders: vi.fn(), getOrder: vi.fn() };
  const faq = { answer: vi.fn() };
  const memory = { get: vi.fn(), add: vi.fn() };
  const refunds = {
    findOpenForOrder: vi.fn(),
    hasApprovedForOrder: vi.fn(),
    create: vi.fn(),
  };
  const traces = { record: vi.fn(), costSince: vi.fn() };
  const signal = new AbortController().signal;

  const makeService = (
    model: FakeChatModel,
    strong = model,
    langfuse: LangfuseTracing | null = null,
    budget: DailyBudget | null = null,
  ) =>
    new ChatService(
      model as unknown as BaseChatModel,
      strong as unknown as BaseChatModel,
      orders as unknown as OrdersClient,
      faq as unknown as FaqService,
      saver,
      memory,
      refunds as unknown as RefundStore,
      traces,
      langfuse,
      budget,
    );

  let traceEvents: Extract<ChatEvent, { type: 'trace' }>[] = [];
  const run = async (
    model: FakeChatModel,
    message = 'where is my order?',
    requestSignal = signal,
    turn: Partial<ChatTurn> = {},
    service = makeService(model),
  ) => {
    const events: ChatEvent[] = [];
    for await (const event of service.reply(
      {
        message,
        token: 'tok',
        customerId: CUSTOMER,
        threadId: THREAD,
        ...turn,
      },
      requestSignal,
    ))
      // The closing `trace` event is checked in the traces tests; the others assert the rest.
      if (event.type === 'trace') traceEvents.push(event);
      else events.push(event);
    return events;
  };

  const toolResults = (model: FakeChatModel) =>
    model.turnInputs
      .at(-1)!
      .filter((m): m is ToolMessage => m instanceof ToolMessage)
      .map((m) => m.content);

  beforeEach(() => {
    traceEvents = [];
    saver = new MemorySaver();
    memory.get.mockReset().mockResolvedValue([]);
    memory.add.mockReset().mockResolvedValue(undefined);
    traces.record.mockReset().mockResolvedValue(undefined);
    refunds.findOpenForOrder.mockReset().mockResolvedValue(null);
    refunds.hasApprovedForOrder.mockReset().mockResolvedValue(false);
    refunds.create.mockReset().mockResolvedValue({
      ok: true,
      refund: { id: 'ref_new', status: 'pending_approval' },
    });
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
          threadId: THREAD,
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

  it('sends routing and fact extraction to the cheap model, the tool loop to the strong one', async () => {
    const cheap = new FakeChatModel([]);
    const strong = new FakeChatModel(
      [[text('Your kettle shipped.')]],
      [{ answer: 'Your kettle has shipped.', orderIds: [] }],
      [],
    );

    await run(
      cheap,
      'where is my order?',
      signal,
      {},
      makeService(cheap, strong),
    );

    expect(cheap.routerInputs).toHaveLength(1);
    expect(cheap.factInputs).toHaveLength(1);
    expect(cheap.turnInputs).toHaveLength(0);
    expect(cheap.structuredInputs).toHaveLength(0);
    expect(strong.turnInputs).toHaveLength(1);
    expect(strong.structuredInputs).toHaveLength(1);
    expect(strong.routerInputs).toHaveLength(0);
    expect(strong.factInputs).toHaveLength(0);
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
        threadId: THREAD,
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
      data: {
        answer: 'Sorry.',
        orderIds: [],
        route: 'order',
        threadId: THREAD,
      },
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
      data: {
        answer: 'Hi.',
        orderIds: [],
        route: 'order',
        threadId: THREAD,
      },
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

  describe('refund route', () => {
    afterEach(() => vi.useRealTimers());

    it('stores a valid request and answers from fixed text without streaming model prose', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
      orders.getOrder.mockResolvedValue({
        ok: true,
        data: {
          ...ORDER_FIXTURE,
          total: '89.90',
          status: 'delivered',
          deliveredAt: '2026-08-06T16:30:00.000Z',
        },
      });
      const model = new FakeChatModel(
        [[text('Sure, I approved it!')]],
        [{ orderId: 'ord_1001', amount: null, reason: 'Arrived broken' }],
        [{ intent: 'refund' }],
      );

      const events = await run(model, 'I want a refund for ord_1001');

      expect(events.map((e) => e.type)).toEqual(['approval_required', 'final']);
      expect(events[1]).toMatchObject({
        type: 'final',
        data: {
          route: 'refund',
          orderIds: ['ord_1001'],
          refund: { id: 'ref_new', status: 'pending_approval' },
          threadId: THREAD,
        },
      });
      expect(JSON.stringify(events)).not.toContain('approved it');
      expect(refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: CUSTOMER,
          amount: '89.90',
          status: 'pending_approval',
        }),
      );
    });

    describe('operator approval pause', () => {
      const KEY = threadKey(CUSTOMER, THREAD);
      const pendingModel = () =>
        new FakeChatModel(
          [[text('ok')]],
          [{ orderId: 'ord_1001', amount: null, reason: 'Arrived broken' }],
          [{ intent: 'refund' }],
        );
      const arrange = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
        orders.getOrder.mockResolvedValue({
          ok: true,
          data: {
            ...ORDER_FIXTURE,
            total: '89.90',
            status: 'delivered',
            deliveredAt: '2026-08-06T16:30:00.000Z',
          },
        });
      };
      const NEW_REFUND = {
        id: 'ref_new',
        orderId: 'ord_1001',
        amount: '89.90',
      };
      /** Nodes still waiting to run for the thread; empty when the run finished. */
      const nextNodes = async (service: ChatService) =>
        (
          await (
            service as unknown as {
              graph: {
                getState: (c: unknown) => Promise<{ next: string[] }>;
              };
            }
          ).graph.getState({ configurable: { thread_id: KEY } })
        ).next;
      const lastMessage = async () => {
        const tuple = await saver.getTuple({
          configurable: { thread_id: KEY },
        });
        const messages = tuple!.checkpoint.channel_values
          .messages as BaseMessage[];
        return messages.at(-1)!.content;
      };

      it('pauses at the approval node after a new pending request', async () => {
        arrange();
        const service = makeService(pendingModel());

        const events = await run(
          pendingModel(),
          'refund ord_1001',
          signal,
          {},
          service,
        );

        expect(events[0]).toEqual({
          type: 'approval_required',
          data: { refundId: 'ref_new', orderId: 'ord_1001', amount: '89.90' },
        });
        expect(events.at(-1)!.type).toBe('final');
        expect(await nextNodes(service)).toEqual(['await_approval']);
        expect(refunds.create).toHaveBeenCalledWith(
          expect.objectContaining({ threadKey: KEY }),
        );
      });

      it.each([
        ['approved', REFUND_REPLIES.approved('ref_new', '89.90', 'ord_1001')],
        ['rejected', REFUND_REPLIES.declined('ref_new', '89.90', 'ord_1001')],
      ] as const)(
        'records a %s decision as a fixed message in the thread',
        async (decision, expected) => {
          arrange();
          const service = makeService(pendingModel());
          await run(pendingModel(), 'refund ord_1001', signal, {}, service);

          await service.resumeRefund(KEY, CUSTOMER, NEW_REFUND, decision);

          expect(await lastMessage()).toBe(expected);
          expect(await nextNodes(service)).toEqual([]);
        },
      );

      it('lets the customer keep chatting on a thread that is still paused', async () => {
        arrange();
        await run(pendingModel(), 'refund ord_1001');

        const events = await run(
          new FakeChatModel([[text('hi')]]),
          'where is my order?',
        );

        expect(events.at(-1)).toMatchObject({
          type: 'final',
          data: { route: 'order' },
        });
      });

      it('appends the decision message when the customer wrote again before the decision', async () => {
        arrange();
        // One scripted model serves both turns because the service keeps it.
        const model = new FakeChatModel(
          [[text('ok')]],
          [{ orderId: 'ord_1001', amount: null, reason: 'Arrived broken' }],
          [{ intent: 'refund' }, { intent: 'out_of_scope' }],
        );
        const service = makeService(model);
        await run(model, 'refund ord_1001', signal, {}, service);
        await run(model, 'thanks', signal, {}, service);
        expect(await nextNodes(service)).toEqual([]);

        await service.resumeRefund(KEY, CUSTOMER, NEW_REFUND, 'approved');

        expect(await lastMessage()).toBe(
          REFUND_REPLIES.approved('ref_new', '89.90', 'ord_1001'),
        );
        expect(await nextNodes(service)).toEqual([]);
      });

      it('appends the decision message when the client closed the stream after final', async () => {
        arrange();
        const service = makeService(pendingModel());
        const abort = new AbortController();
        for await (const event of service.reply(
          {
            message: 'refund ord_1001',
            token: 'tok',
            customerId: CUSTOMER,
            threadId: THREAD,
          },
          abort.signal,
        ))
          if (event.type === 'final') abort.abort();
        // The cut-off run never reached the pause and left a stale step behind.
        const next = await nextNodes(service);
        expect(next).not.toEqual([]);
        expect(next).not.toContain('await_approval');

        await service.resumeRefund(KEY, CUSTOMER, NEW_REFUND, 'approved');

        expect(await lastMessage()).toBe(
          REFUND_REPLIES.approved('ref_new', '89.90', 'ord_1001'),
        );
      });

      it('refuses a decision for a thread that never ran', async () => {
        const service = makeService(pendingModel());

        await expect(
          service.resumeRefund(KEY, CUSTOMER, NEW_REFUND, 'approved'),
        ).rejects.toBeInstanceOf(RefundNotPausedError);
      });

      it('records a decision only against the request the thread is paused on', async () => {
        arrange();
        const proposal = {
          orderId: 'ord_1001',
          amount: null,
          reason: 'Arrived broken',
        };
        // One scripted model serves both turns because the service keeps it.
        const model = new FakeChatModel(
          [[text('ok')], [text('ok')]],
          [proposal, proposal],
          [{ intent: 'refund' }, { intent: 'refund' }],
        );
        const service = makeService(model);
        await run(model, 'refund ord_1001', signal, {}, service);
        // The customer files a second request in the same thread; it replaces the first pause.
        refunds.create.mockResolvedValue({
          ok: true,
          refund: { id: 'ref_b', status: 'pending_approval' },
        });
        await run(model, 'refund ord_1001 again', signal, {}, service);
        const before = await lastMessage();

        await expect(
          service.resumeRefund(KEY, CUSTOMER, NEW_REFUND, 'approved'),
        ).rejects.toBeInstanceOf(RefundNotPausedError);
        expect(await lastMessage()).toBe(before);

        await service.resumeRefund(
          KEY,
          CUSTOMER,
          { ...NEW_REFUND, id: 'ref_b' },
          'rejected',
        );
        expect(await lastMessage()).toBe(
          REFUND_REPLIES.declined('ref_b', '89.90', 'ord_1001'),
        );
      });

      it.each([
        [
          'an auto-rejected request',
          { ok: true, refund: { id: 'ref_new', status: 'auto_rejected' } },
          null,
          '100.00',
        ],
        [
          'a duplicate open request',
          { ok: true, refund: { id: 'ref_new', status: 'pending_approval' } },
          { id: 'ref_open', status: 'pending_approval' },
          null,
        ],
      ])('does not pause for %s', async (_label, created, open, amount) => {
        arrange();
        refunds.create.mockResolvedValue(created);
        refunds.findOpenForOrder.mockResolvedValue(open);
        const model = new FakeChatModel(
          [[text('ok')]],
          [{ orderId: 'ord_1001', amount, reason: 'Arrived broken' }],
          [{ intent: 'refund' }],
        );
        const service = makeService(model);

        const events = await run(model, 'refund ord_1001', signal, {}, service);

        expect(events.map((e) => e.type)).toEqual(['final']);
        expect(await nextNodes(service)).toEqual([]);
      });
    });

    it('answers with the fallback text, not an error event, when the agent fails', async () => {
      const model = new FakeChatModel(
        [[text('hmm')]],
        [
          new OutputParserException('bad json'),
          new OutputParserException('bad json'),
        ],
        [{ intent: 'refund' }],
      );

      const events = await run(model, 'refund please');

      expect(events.map((e) => e.type)).toEqual(['final']);
      expect(events[0]).toMatchObject({
        data: { route: 'refund', orderIds: [] },
      });
      expect(refunds.create).not.toHaveBeenCalled();
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
            threadId: THREAD,
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
        [{ intent: 'cancel' }, { intent: 'faq' }],
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

  describe('threads', () => {
    it('gives a follow-up in the same thread the earlier turns', async () => {
      const model = new FakeChatModel(
        [[text('It shipped.')], [text('Tomorrow.')]],
        [
          { answer: 'It shipped.', orderIds: [] },
          { answer: 'Tomorrow.', orderIds: [] },
        ],
        [{ intent: 'order' }, { intent: 'order' }],
      );

      await run(model, 'where is my kettle?');
      await run(model, 'when will it arrive?');

      const contents = (messages: BaseMessage[]) =>
        messages.map((m) => m.content);
      expect(contents(model.routerInputs[1])).toEqual([
        expect.stringContaining('route'),
        'where is my kettle?',
        'It shipped.',
        'when will it arrive?',
      ]);
      expect(contents(model.turnInputs[1])).toEqual([
        expect.stringContaining('support assistant'),
        'where is my kettle?',
        'It shipped.',
        'when will it arrive?',
      ]);
      expect(model.routerInputs[0]).toHaveLength(2);
    });

    const stored = async (customerId: string, threadId = THREAD) =>
      saver.getTuple({
        configurable: { thread_id: threadKey(customerId, threadId) },
      });

    it('never writes the caller token to any checkpoint of the thread', async () => {
      const model = new FakeChatModel(
        [[text('Hi.')], [text('Hi.')]],
        undefined,
        [{ intent: 'order' }, { intent: 'order' }],
      );
      for (const message of ['where is my order?', 'and my other one?'])
        await run(model, message, signal, { token: 'secret-jwt-value' });

      const checkpoints = [];
      for await (const tuple of saver.list({
        configurable: { thread_id: threadKey(CUSTOMER, THREAD) },
      }))
        checkpoints.push(tuple);

      expect(checkpoints.length).toBeGreaterThan(2);
      expect(JSON.stringify(checkpoints)).not.toContain('secret-jwt-value');
    });

    it('persists the human and answer messages under the caller-scoped thread', async () => {
      await run(new FakeChatModel([[text('Hi.')]]));

      const values = (await stored(CUSTOMER))!.checkpoint.channel_values;

      expect((values.messages as BaseMessage[]).map((m) => m.content)).toEqual([
        'where is my order?',
        'Your kettle has shipped.',
      ]);
    });

    it('keeps the same thread id of two customers separate', async () => {
      await run(new FakeChatModel([[text('Hi.')]]));

      expect(await stored('cus_ben')).toBeUndefined();
      await run(new FakeChatModel([[text('Hi.')]]), 'hello', signal, {
        customerId: 'cus_ben',
      });
      const ben = (await stored('cus_ben'))!.checkpoint.channel_values;

      expect((ben.messages as BaseMessage[]).map((m) => m.content)).toEqual([
        'hello',
        'Your kettle has shipped.',
      ]);
    });

    describe('compaction', () => {
      const longThread = (summaryResults: unknown[]) =>
        new FakeChatModel(
          Array.from({ length: 8 }, () => [text('ok')]),
          [
            ...Array.from({ length: 7 }, (_, i) => ({
              answer: `answer ${i + 1}`,
              orderIds: [],
            })),
            ...summaryResults,
            { answer: 'answer 8', orderIds: [] },
          ],
          Array.from({ length: 8 }, () => ({ intent: 'order' })),
        );

      const turnsOf = async (model: FakeChatModel, count: number) => {
        const all: ChatEvent[][] = [];
        for (let i = 1; i <= count; i++)
          all.push(await run(model, `question ${i}`));
        return all;
      };

      it('folds older messages into a summary that reaches the next prompt', async () => {
        const model = longThread([
          { summary: 'Customer asked about a kettle.' },
        ]);

        await turnsOf(model, 7);

        const values = (await stored(CUSTOMER))!.checkpoint.channel_values;
        const kept = (values.messages as BaseMessage[]).map((m) => m.content);
        expect(values.summary).toBe('Customer asked about a kettle.');
        expect(kept).toEqual([
          'question 5',
          'answer 5',
          'question 6',
          'answer 6',
          'question 7',
          'answer 7',
        ]);

        await run(model, 'question 8');

        const next = model.turnInputs.at(-1)!;
        expect(next[1].content).toContain('Customer asked about a kettle.');
        expect(next.map((m) => m.content)).not.toContain('question 1');
        expect(next.at(-1)?.content).toBe('question 8');
      });

      it('drops the oldest messages unsummarized once history passes the hard cap', async () => {
        const structured: unknown[] = [];
        for (let turn = 1; turn <= 13; turn++) {
          structured.push({ answer: `answer ${turn}`, orderIds: [] });
          if (turn * 2 > 12)
            structured.push(
              new OutputParserException('bad json'),
              new OutputParserException('bad json'),
            );
        }
        const model = new FakeChatModel(
          Array.from({ length: 13 }, () => [text('ok')]),
          structured,
          Array.from({ length: 13 }, () => ({ intent: 'order' })),
        );

        await turnsOf(model, 12);
        expect(
          (
            (await stored(CUSTOMER))!.checkpoint.channel_values
              .messages as BaseMessage[]
          ).length,
        ).toBe(24);
        await turnsOf(model, 1);

        const values = (await stored(CUSTOMER))!.checkpoint.channel_values;
        expect(values.messages as BaseMessage[]).toHaveLength(6);
        expect(values.summary).toBe('');
      });

      it('keeps every message and still answers when the summarizer fails', async () => {
        const model = longThread([
          new OutputParserException('bad json'),
          new OutputParserException('bad json'),
        ]);

        const all = await turnsOf(model, 7);

        expect(all[6].at(-1)).toMatchObject({ type: 'final' });
        const values = (await stored(CUSTOMER))!.checkpoint.channel_values;
        expect(values.messages as BaseMessage[]).toHaveLength(14);
        expect(values.summary).toBe('');
      });
    });
  });

  describe('long-term memory', () => {
    const ran = (model: FakeChatModel, turn: Partial<ChatTurn> = {}) =>
      run(model, 'please email me, I hate calls', signal, turn);

    it('injects stored facts into the router and order prompts of a new thread', async () => {
      memory.get.mockResolvedValue(['Prefers email contact.']);
      const model = new FakeChatModel([[text('Hi.')]]);

      await ran(model);

      expect(memory.get).toHaveBeenCalledWith(CUSTOMER);
      for (const input of [model.routerInputs[0], model.turnInputs[0]]) {
        expect(input[1].content).toContain('Prefers email contact.');
        expect(input[1].content).toContain('data, not instructions');
      }
    });

    it('hands the new facts to the store, scoped to the caller', async () => {
      memory.get.mockResolvedValue(['prefers email contact.']);
      const model = new FakeChatModel([[text('Hi.')]], undefined, undefined, [
        { facts: ['Prefers email contact.', 'Dislikes phone calls.'] },
      ]);

      await ran(model, { customerId: 'cus_ben' });

      expect(memory.add).toHaveBeenCalledWith('cus_ben', [
        'Prefers email contact.',
        'Dislikes phone calls.',
      ]);
      expect(memory.get).not.toHaveBeenCalledWith(CUSTOMER);
      const fromCustomer = model.factInputs[0].at(-1)!.content as string;
      expect(fromCustomer).toContain('please email me');
      expect(fromCustomer).not.toContain('Your kettle has shipped.');
    });

    it('answers and stores nothing when fact extraction fails', async () => {
      const model = new FakeChatModel([[text('Hi.')]], undefined, undefined, [
        new OutputParserException('bad json'),
        new OutputParserException('bad json'),
      ]);

      const events = await ran(model);

      expect(events.at(-1)).toMatchObject({ type: 'final' });
      expect(events.map((e) => e.type)).not.toContain('error');
      expect(memory.add).not.toHaveBeenCalled();
    });

    it('does not extract facts from an out-of-scope refusal', async () => {
      const model = new FakeChatModel(
        [],
        [],
        [{ intent: 'out_of_scope' }],
        [{ facts: ['Likes tea.'] }],
      );

      await ran(model);

      expect(model.factInputs).toHaveLength(0);
      expect(memory.add).not.toHaveBeenCalled();
    });

    it('does not write when nothing new is found', async () => {
      await ran(new FakeChatModel([[text('Hi.')]]));

      expect(memory.add).not.toHaveBeenCalled();
    });

    it('answers normally when the memory store fails to read or write', async () => {
      memory.get.mockRejectedValue(new Error('db down'));
      memory.add.mockRejectedValue(new Error('db down'));
      const model = new FakeChatModel([[text('Hi.')]], undefined, undefined, [
        { facts: ['Dislikes phone calls.'] },
      ]);

      const events = await ran(model);

      expect(events.map((e) => e.type)).toEqual(['token', 'final']);
      expect(events.at(-1)).toMatchObject({
        data: { answer: 'Your kettle has shipped.' },
      });
    });
  });
  describe('daily budget', () => {
    const budgetOf = (exceeded: boolean | Error) =>
      ({
        exceeded: vi.fn(async () => {
          if (exceeded instanceof Error) throw exceeded;
          return exceeded;
        }),
      }) as unknown as DailyBudget;

    it('answers with the fixed reply and no model, orders or checkpoint call once exceeded', async () => {
      const model = new FakeChatModel([]);
      const events = await run(
        model,
        'where is my order?',
        signal,
        {},
        makeService(model, model, null, budgetOf(true)),
      );

      expect(events).toEqual([
        {
          type: 'final',
          data: {
            answer: BUDGET_REPLY,
            orderIds: [],
            route: 'budget',
            threadId: THREAD,
          },
        },
      ]);
      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].data).toMatchObject({
        route: 'budget',
        tools: [],
        provider: null,
        model: null,
        costUsd: null,
        status: 'ok',
      });
      expect(model.routerInputs).toHaveLength(0);
      expect(model.turnInputs).toHaveLength(0);
      expect(orders.listOrders).not.toHaveBeenCalled();
      expect(orders.getOrder).not.toHaveBeenCalled();
      const checkpoints = [];
      for await (const tuple of saver.list({})) checkpoints.push(tuple);
      expect(checkpoints).toHaveLength(0);
      await vi.waitFor(() => expect(traces.record).toHaveBeenCalledTimes(1));
      expect(traces.record.mock.calls[0][0]).toMatchObject({
        id: traceEvents[0].data.id,
        route: 'budget',
        calls: [],
        status: 'ok',
      });
    });

    it('runs the agent as usual while under the cap', async () => {
      const model = new FakeChatModel([[text('Your kettle shipped.')]]);
      const budget = budgetOf(false);
      const events = await run(
        model,
        'where is my order?',
        signal,
        {},
        makeService(model, model, null, budget),
      );

      expect(budget.exceeded).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        type: 'final',
        data: { route: 'order' },
      });
    });

    it('queries no spend when no budget is configured', async () => {
      const model = new FakeChatModel([[text('Your kettle shipped.')]]);
      await run(model);

      expect(traces.costSince).not.toHaveBeenCalled();
    });
  });

  describe('Langfuse', () => {
    /** Counts the callbacks it receives; throws on every one when `failing`. */
    class SpyHandler extends BaseCallbackHandler {
      name = 'spy-langfuse';
      awaitHandlers = true;
      starts = 0;
      constructor(private readonly failing = false) {
        super();
      }
      handleChainStart(): void {
        this.starts++;
        if (this.failing) throw new Error('langfuse down');
      }
      handleChatModelStart(): void {
        if (this.failing) throw new Error('langfuse down');
      }
      handleLLMEnd(): void {
        if (this.failing) throw new Error('langfuse down');
      }
    }
    const tracingWith = (handler: SpyHandler) => ({
      handlerFor: vi.fn(() => handler),
      flush: vi.fn(async () => undefined),
    });
    const reply = (service: ChatService) =>
      (async () => {
        const out: ChatEvent[] = [];
        for await (const event of service.reply(
          {
            message: 'where is my order?',
            token: 'tok',
            customerId: CUSTOMER,
            threadId: THREAD,
          },
          signal,
        ))
          out.push(event);
        return out;
      })();

    it('binds one handler per request to the stored trace id, thread and customer', async () => {
      const handler = new SpyHandler();
      const tracing = tracingWith(handler);

      await reply(
        makeService(
          new FakeChatModel([[text('Your kettle shipped.')]]),
          undefined,
          tracing,
        ),
      );

      const recorded = traces.record.mock.calls[0][0] as TraceRecord;
      expect(tracing.handlerFor).toHaveBeenCalledTimes(1);
      expect(tracing.handlerFor).toHaveBeenCalledWith(recorded.id, {
        sessionId: THREAD,
        userId: CUSTOMER,
      });
      expect(handler.starts).toBeGreaterThan(0);
    });

    it('keeps the reply and the stored trace when the handler throws on every callback', async () => {
      const healthy = await reply(
        makeService(new FakeChatModel([[text('Your kettle shipped.')]])),
      );
      const healthyRow = traces.record.mock.calls[0][0] as TraceRecord;
      traces.record.mockClear();

      const events = await reply(
        makeService(
          new FakeChatModel([[text('Your kettle shipped.')]]),
          undefined,
          tracingWith(new SpyHandler(true)),
        ),
      );

      const strip = (list: ChatEvent[]) =>
        list.map((e) =>
          e.type === 'trace'
            ? { ...e, data: { ...e.data, id: '', latencyMs: 0 } }
            : e,
        );
      expect(strip(events)).toEqual(strip(healthy));
      expect(traces.record.mock.calls[0][0]).toMatchObject({
        route: healthyRow.route,
        tools: healthyRow.tools,
        status: 'ok',
      });
    });

    it('flushes Langfuse with the trace writes and survives a failed flush', async () => {
      const tracing = tracingWith(new SpyHandler());
      let release!: () => void;
      tracing.flush.mockReturnValueOnce(
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
      );
      const service = makeService(new FakeChatModel([]), undefined, tracing);

      let flushed = false;
      const flush = service.flushTraces().then(() => {
        flushed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracing.flush).toHaveBeenCalledTimes(1);
      expect(flushed).toBe(false);
      release();
      await flush;
      expect(flushed).toBe(true);

      tracing.flush.mockRejectedValueOnce(new Error('langfuse down'));
      await expect(service.flushTraces()).resolves.toBeUndefined();
    });

    it('creates no handler and flushes nothing when Langfuse is off', async () => {
      const service = makeService(
        new FakeChatModel([[text('Your kettle shipped.')]]),
      );

      await expect(reply(service)).resolves.toHaveLength(3);
      await expect(service.flushTraces()).resolves.toBeUndefined();
    });
  });

  describe('traces', () => {
    const USAGE = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      total_tokens: 1_100_000,
      input_token_details: { cache_read: 400_000, cache_creation: 0 },
    };
    const recorded = () => traces.record.mock.calls[0][0] as TraceRecord;

    it('records the route, tools and one priced call per model invocation', async () => {
      const model = new FakeChatModel([
        [toolCall('get_order', { orderId: 'ord_1001' })],
        [text('Your kettle shipped.')],
      ]);
      model.usage = USAGE;

      await run(model);

      expect(traces.record).toHaveBeenCalledTimes(1);
      const trace = recorded();
      expect(trace).toMatchObject({
        customerId: CUSTOMER,
        threadId: THREAD,
        route: 'order',
        tools: ['get_order'],
        status: 'ok',
      });
      // router, two tool-loop turns, final structured answer, fact extraction.
      expect(trace.calls.length).toBeGreaterThanOrEqual(4);
      expect(trace.calls[0]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        tier: 'strong',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 400_000,
      });
      // 0.6M * 3 + 0.4M * 0.3 + 0.1M * 15 USD per million
      expect(trace.calls[0].costUsd).toBeCloseTo(1.8 + 0.12 + 1.5, 6);
    });

    it('records an error turn with the error status and no route', async () => {
      const model = new FakeChatModel([], [], [new Error('router down')]);

      const events = await run(model);

      expect(events.at(-1)?.type).toBe('error');
      expect(recorded()).toMatchObject({
        route: null,
        status: 'error',
        tools: [],
      });
    });

    it('records an aborted turn', async () => {
      const abort = new AbortController();
      abort.abort();

      await run(new FakeChatModel([[text('hi')]]), 'hi', abort.signal);

      expect(recorded().status).toBe('aborted');
    });

    it('keeps the chat response when the store throws', async () => {
      traces.record.mockRejectedValue(new Error('db down'));

      const events = await run(
        new FakeChatModel([[text('Your kettle shipped.')]]),
      );

      expect(events.at(-1)).toMatchObject({
        type: 'final',
        data: { answer: 'Your kettle has shipped.' },
      });
      // Let the swallowed rejection settle: it must not surface as unhandled.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(traces.record).toHaveBeenCalledTimes(1);
    });

    it('finishes the reply even when the trace write never settles', async () => {
      traces.record.mockReturnValue(new Promise(() => undefined));

      const events = await run(
        new FakeChatModel([[text('Your kettle shipped.')]]),
      );

      expect(events.at(-1)).toMatchObject({ type: 'final' });
      expect(traces.record).toHaveBeenCalledTimes(1);
    });

    it('flushTraces waits for a slow trace write and is immediate when none is pending', async () => {
      const service = makeService(
        new FakeChatModel([[text('Your kettle shipped.')]]),
      );
      await expect(service.flushTraces()).resolves.toBeUndefined();

      let finish!: () => void;
      traces.record.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      await run(
        new FakeChatModel([]),
        'where is my order?',
        signal,
        {},
        service,
      );

      let flushed = false;
      const flush = service.flushTraces().then(() => {
        flushed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(flushed).toBe(false);

      finish();
      await flush;
      expect(flushed).toBe(true);
    });

    const rawEvents = async (
      model: FakeChatModel,
      message: string,
      sig = signal,
    ) => {
      const out: ChatEvent[] = [];
      for await (const event of makeService(model).reply(
        { message, token: 'tok', customerId: CUSTOMER, threadId: THREAD },
        sig,
      ))
        out.push(event);
      return out;
    };

    it('closes a successful reply with a trace event that matches the stored row', async () => {
      const model = new FakeChatModel([
        [toolCall('get_order', { orderId: 'ord_1001' })],
        [text('Your kettle shipped.')],
      ]);
      model.usage = USAGE;

      const events = await rawEvents(model, 'my secret question');

      expect(events.slice(-2).map((e) => e.type)).toEqual(['final', 'trace']);
      const trace = events.at(-1) as Extract<ChatEvent, { type: 'trace' }>;
      const row = recorded();
      const total = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens') =>
        row.calls.reduce((sum, call) => sum + call[key], 0);
      expect(trace.data).toMatchObject({
        id: row.id,
        route: 'order',
        tools: ['get_order'],
        provider: row.calls.at(-1)?.provider,
        model: row.calls.at(-1)?.model,
        failovers: 0,
        latencyMs: row.latencyMs,
        status: 'ok',
        tokens: {
          input: total('inputTokens'),
          output: total('outputTokens'),
          cacheRead: total('cacheReadTokens'),
          cacheWrite: 0,
        },
      });
      expect(row.failovers).toBe(0);
      expect(trace.data.costUsd).toMatch(/^\d+\.\d{6}$/);
      expect(JSON.stringify(trace)).not.toContain('secret');
      expect(JSON.stringify(trace)).not.toContain('kettle');
    });

    it('follows an error with a trace event for the same stored row', async () => {
      const events = await rawEvents(
        new FakeChatModel([], [], [new Error('router down')]),
        'hi',
      );

      expect(events.slice(-2).map((e) => e.type)).toEqual(['error', 'trace']);
      expect(events.at(-1)?.data).toMatchObject({
        id: recorded().id,
        route: null,
        status: 'error',
      });
    });

    it('sends no trace event for an aborted request but still records it', async () => {
      const abort = new AbortController();
      abort.abort();

      const events = await rawEvents(
        new FakeChatModel([[text('hi')]]),
        'hi',
        abort.signal,
      );

      expect(events.some((e) => e.type === 'trace')).toBe(false);
      expect(recorded().status).toBe('aborted');
    });

    it('sends exactly one trace event per reply through the run helper too', async () => {
      await run(new FakeChatModel([[text('Your kettle shipped.')]]));

      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].data.id).toBe(recorded().id);
    });

    it('stores no message text', async () => {
      await run(
        new FakeChatModel([[text('secret reply')]]),
        'my secret question',
      );

      const stored = JSON.stringify(traces.record.mock.calls);
      expect(stored).not.toContain('secret');
    });
  });
});
