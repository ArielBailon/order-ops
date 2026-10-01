import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';
import { OutputParserException } from '@langchain/core/output_parsers';
import type { AgentEvent, Order } from '../chat/chat.schemas.js';
import { ORDER_FIXTURE } from '../chat/order.fixture.js';
import type { OrdersClient } from '../chat/orders.client.js';
import type { RefundStore } from '../refunds/refund.store.js';
import { REFUND_REPLIES, runRefundRoute } from './refund-route.js';

const NOW = new Date('2026-08-20T00:00:00.000Z');
const delivered = (overrides: Partial<Order> = {}): Order => ({
  ...ORDER_FIXTURE,
  total: '89.90',
  status: 'delivered',
  deliveredAt: '2026-08-06T16:30:00.000Z',
  ...overrides,
});

/** Stand-in model: one prose turn from the tool loop, then scripted structured proposals. */
const fakeModel = (proposals: unknown[]) => {
  const inputs: unknown[][] = [];
  const model = {
    bindTools: () => ({
      stream: async () =>
        (async function* () {
          yield new AIMessageChunk({ content: 'I will approve this for you.' });
        })(),
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        inputs.push(messages);
        const result = proposals.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    }),
  } as unknown as BaseChatModel;
  return { model, inputs };
};

describe('runRefundRoute', () => {
  const getOrder = vi.fn();
  const orders = { getOrder, listOrders: vi.fn() } as unknown as OrdersClient;
  const refunds = {
    findOpenForOrder: vi.fn(),
    create: vi.fn(),
  } satisfies RefundStore;
  const emit = vi.fn<(event: AgentEvent) => void>();
  const signal = new AbortController().signal;

  const run = (
    proposals: unknown[],
    overrides: Partial<Parameters<typeof runRefundRoute>[0]> = {},
  ) =>
    runRefundRoute({
      model: fakeModel(proposals).model,
      orders,
      refunds,
      message: 'I want a refund for ord_1001',
      history: [],
      token: 'tok',
      customerId: 'cus_ana',
      signal,
      emit,
      now: () => NOW,
      ...overrides,
    });
  const proposal = (overrides: Record<string, unknown> = {}) => ({
    orderId: 'ord_1001',
    amount: null,
    reason: 'Arrived broken',
    ...overrides,
  });

  beforeEach(() => {
    getOrder.mockReset().mockResolvedValue({ ok: true, data: delivered() });
    refunds.findOpenForOrder.mockReset().mockResolvedValue(null);
    refunds.create
      .mockReset()
      .mockImplementation(async (input: { status: string }) => ({
        ok: true,
        refund: { id: 'ref_new', status: input.status },
      }));
    emit.mockReset();
  });

  it('stores a valid partial request as pending_approval and replies from a fixed text', async () => {
    const result = await run([proposal({ amount: '20.5' })]);

    expect(refunds.create).toHaveBeenCalledWith({
      orderId: 'ord_1001',
      customerId: 'cus_ana',
      amount: '20.50',
      reason: 'Arrived broken',
      status: 'pending_approval',
    });
    expect(result).toEqual({
      answer: REFUND_REPLIES.submitted('ref_new', '20.50', 'ord_1001'),
      orderIds: ['ord_1001'],
      route: 'refund',
      refund: { id: 'ref_new', status: 'pending_approval' },
    });
    expect(getOrder).toHaveBeenCalledWith('tok', 'ord_1001', signal);
  });

  it('uses the full order total when the proposal has no amount', async () => {
    await run([proposal()]);

    expect(refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '89.90' }),
    );
  });

  it.each([
    [
      'not_delivered',
      { order: delivered({ status: 'shipped', deliveredAt: null }) },
      {},
    ],
    ['window_expired', {}, { now: () => new Date('2026-10-01T00:00:00Z') }],
    ['amount_exceeds_total', {}, { amount: '100.00' }],
  ])(
    'stores %s as auto_rejected with a fixed explanation',
    async (code, { order }: { order?: Order }, extra) => {
      if (order) getOrder.mockResolvedValue({ ok: true, data: order });
      const { now, ...proposalExtra } = extra as {
        now?: () => Date;
        amount?: string;
      };

      const result = await run([proposal(proposalExtra)], now ? { now } : {});

      expect(refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'auto_rejected',
          decisionReason: code,
          customerId: 'cus_ana',
        }),
      );
      expect(result.refund).toEqual({ id: 'ref_new', status: 'auto_rejected' });
      expect(result.answer).toContain('declined automatically');
      expect(result.answer).toContain('ref_new');
      expect(result.answer).not.toMatch(/approved|will be refunded/i);
    },
  );

  it('reuses the open request instead of creating another', async () => {
    refunds.findOpenForOrder.mockResolvedValue({
      id: 'ref_old',
      status: 'pending_approval',
    });

    const result = await run([proposal()]);

    expect(refunds.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      answer: REFUND_REPLIES.duplicate('ref_old', 'ord_1001'),
      orderIds: ['ord_1001'],
      route: 'refund',
      refund: { id: 'ref_old', status: 'pending_approval' },
    });
  });

  it('treats a lost insert race as a duplicate', async () => {
    refunds.create.mockResolvedValue({
      ok: false,
      code: 'open_request_exists',
      existing: { id: 'ref_race', status: 'pending_approval' },
    });

    const result = await run([proposal()]);

    expect(result.answer).toBe(
      REFUND_REPLIES.duplicate('ref_race', 'ord_1001'),
    );
    expect(result.refund?.id).toBe('ref_race');
  });

  it.each([
    [
      'not found',
      { ok: false, error: 'not_found' },
      REFUND_REPLIES.orderNotFound,
    ],
    [
      'unavailable',
      { ok: false, error: 'unavailable' },
      REFUND_REPLIES.ordersUnavailable,
    ],
    [
      "another customer's order",
      { ok: true, data: delivered({ customerId: 'cus_ben' }) },
      REFUND_REPLIES.orderNotFound,
    ],
  ])('stores nothing when the order is %s', async (_name, result, answer) => {
    getOrder.mockResolvedValue(result);

    const reply = await run([proposal()]);

    expect(reply).toEqual({ answer, orderIds: [], route: 'refund' });
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it.each([
    ['order id', proposal({ orderId: null })],
    ['reason', proposal({ reason: '' })],
  ])('asks for details when the %s is missing', async (_name, missing) => {
    const reply = await run([missing]);

    expect(reply.answer).toBe(REFUND_REPLIES.needDetails);
    expect(getOrder).not.toHaveBeenCalled();
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('falls back after two invalid proposals without storing anything', async () => {
    const reply = await run([
      proposal({ amount: '-5' }),
      new OutputParserException('bad json'),
    ]);

    expect(reply).toEqual({
      answer: REFUND_REPLIES.agentFallback,
      orderIds: [],
      route: 'refund',
    });
    expect(getOrder).not.toHaveBeenCalled();
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('falls back when the model call fails', async () => {
    const reply = await run([new Error('provider down')]);

    expect(reply.answer).toBe(REFUND_REPLIES.agentFallback);
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('rethrows when the request was aborted', async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(run([proposal()], { signal: abort.signal })).rejects.toThrow();
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('stops without a reply when the client aborts while the order is fetched', async () => {
    const abort = new AbortController();
    getOrder.mockImplementation(async () => {
      abort.abort();
      return { ok: false, error: 'unavailable' };
    });

    await expect(run([proposal()], { signal: abort.signal })).rejects.toThrow();
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('writes nothing when the client aborts after the order was found', async () => {
    const abort = new AbortController();
    refunds.findOpenForOrder.mockImplementation(async () => {
      abort.abort();
      return null;
    });

    await expect(run([proposal()], { signal: abort.signal })).rejects.toThrow();
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('logs only the error name when the proposal fails', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      await run([new TypeError('secret reason text')]);

      expect(warn).toHaveBeenCalledWith('refund proposal failed: TypeError');
    } finally {
      warn.mockRestore();
    }
  });

  it('never streams model prose, so no unreviewed text reaches the customer', async () => {
    await run([proposal()]);

    expect(emit.mock.calls.map(([event]) => event.type)).not.toContain('token');
  });

  it('rejects an amount that does not fit the stored column', async () => {
    const reply = await run([
      proposal({ amount: '99999999999.00' }),
      proposal({ amount: '99999999999.00' }),
    ]);

    expect(reply.answer).toBe(REFUND_REPLIES.agentFallback);
    expect(refunds.create).not.toHaveBeenCalled();
  });
});
