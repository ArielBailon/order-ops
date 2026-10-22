import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import request from 'supertest';
import { ORDER_FIXTURE } from '../src/chat/order.fixture.js';
import { CHECKPOINTER } from '../src/memory/checkpointer.js';
import { CHEAP_MODEL, STRONG_MODEL } from '../src/models/models.module.js';
import { USER_MEMORY } from '../src/memory/user-memory.store.js';
import { REFUND_STORE } from '../src/refunds/refund.store.js';
import { TRACE_STORE } from '../src/trace/trace.store.js';
import { EMBEDDINGS, POLICY_STORE } from '../src/faq/policy-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('gateway chat (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const fetchMock = vi.fn();
  let turns: AIMessageChunk[][] = [];
  let intent = 'order';
  let proposal: Record<string, unknown> = {};
  const createRefund = vi.fn();
  let routerInputs: BaseMessage[][] = [];
  const similaritySearch = vi.fn();
  const model = {
    bindTools: () => ({
      stream: async () => {
        const turn = turns.shift();
        if (!turn) throw new Error('model unavailable');
        return (async function* () {
          yield* turn;
        })();
      },
    }),
    withStructuredOutput: (_schema: unknown, options?: { name?: string }) => ({
      invoke: async (messages: BaseMessage[]) => {
        if (options?.name === 'route_message') {
          routerInputs.push(messages);
          return { intent };
        }
        if (options?.name === 'remember_facts') return { facts: [] };
        if (options?.name === 'refund_proposal') return proposal;
        if (options?.name === 'faq_answer')
          return { answer: 'Returns are accepted for 30 days.' };
        return { answer: 'Your kettle has shipped.', orderIds: ['ord_1001'] };
      },
    }),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    process.env.OPENAI_API_KEY = 'e2e-fake-key';
    process.env.DATABASE_URL = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e';
    vi.stubGlobal('fetch', fetchMock);
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CHEAP_MODEL)
      .useValue(model)
      .overrideProvider(STRONG_MODEL)
      .useValue(model)
      .overrideProvider(CHECKPOINTER)
      .useValue(new MemorySaver())
      .overrideProvider(TRACE_STORE)
      .useValue({ record: async () => undefined })
      .overrideProvider(REFUND_STORE)
      .useValue({
        findOpenForOrder: async () => null,
        hasApprovedForOrder: async () => false,
        create: createRefund,
        decide: async () => ({ ok: false, code: 'not_found' }),
        listPending: async () => [],
      })
      .overrideProvider(USER_MEMORY)
      .useValue({
        get: async () => [],
        replace: async () => undefined,
      })
      .overrideProvider(EMBEDDINGS)
      .useValue({})
      .overrideProvider(POLICY_STORE)
      .useValue({ similaritySearch })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    token = await new JwtService({ secret: SECRET }).signAsync({
      sub: 'cus_ana',
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    turns = [];
    intent = 'order';
    proposal = {};
    createRefund.mockReset().mockImplementation(async (input) => ({
      ok: true,
      refund: { id: 'ref_e2e', status: input.status },
    }));
    routerInputs = [];
    similaritySearch.mockReset();
  });

  const parseEvents = (body: string) =>
    body
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        return {
          type: eventLine.replace('event: ', ''),
          data: JSON.parse(dataLine.replace('data: ', '')),
        };
      });

  /** The `trace` event that closes every reply: metadata with the stored trace id. */
  const traceEvent = (status: 'ok' | 'error', route: string | null) => ({
    type: 'trace',
    data: expect.objectContaining({
      id: expect.stringMatching(UUID),
      status,
      route,
      failovers: 0,
    }),
  });

  it('POST /chat returns 401 without a token', async () => {
    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: 'hi' })
      .expect(401);
  });

  it('POST /chat returns 400 for an invalid body without calling the model', async () => {
    turns = [[new AIMessageChunk({ content: 'should not run' })]];
    await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '   ' })
      .expect(400);
    expect(turns).toHaveLength(1);
  });

  it('POST /chat returns 400 for a threadId that is not a uuid', async () => {
    await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', threadId: 'not-a-uuid' })
      .expect(400);
  });

  it('POST /chat streams tool_call, token, and final events', async () => {
    fetchMock.mockResolvedValue(Response.json(ORDER_FIXTURE));
    turns = [
      [
        new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              type: 'tool_call_chunk',
              name: 'get_order',
              args: '{"orderId":"ord_1001"}',
              id: 'c1',
              index: 0,
            },
          ],
        }),
      ],
      [
        new AIMessageChunk({ content: 'Your kettle ' }),
        new AIMessageChunk({ content: 'has shipped.' }),
      ],
    ];

    const res = await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'where is ord_1001?' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    expect(parseEvents(res.text)).toEqual([
      {
        type: 'tool_call',
        data: { name: 'get_order', args: { orderId: 'ord_1001' } },
      },
      { type: 'token', data: { text: 'Your kettle ' } },
      { type: 'token', data: { text: 'has shipped.' } },
      {
        type: 'final',
        data: {
          answer: 'Your kettle has shipped.',
          orderIds: ['ord_1001'],
          route: 'order',
          threadId: expect.stringMatching(UUID),
        },
      },
      traceEvent('ok', 'order'),
    ]);
    // The trace event carries metadata only, never the question or the answer.
    const trace = JSON.stringify(parseEvents(res.text).at(-1));
    expect(trace).not.toContain('kettle');
    expect(trace).not.toContain('ord_1001?');
    expect(parseEvents(res.text).at(-1)?.data.tools).toEqual(['get_order']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:3001/orders/ord_1001');
    expect(init.headers).toEqual({ authorization: `Bearer ${token}` });
  });

  it('POST /chat answers a policy question from the FAQ route', async () => {
    intent = 'faq';
    similaritySearch.mockResolvedValue([
      {
        pageContent: 'Returns: 30 days from delivery.',
        metadata: { source: 'returns', section: 'Return window' },
      },
    ]);

    const res = await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'what is your return policy?' })
      .expect(200);

    expect(parseEvents(res.text)).toEqual([
      {
        type: 'final',
        data: {
          answer: 'Returns are accepted for 30 days.',
          orderIds: [],
          route: 'faq',
          threadId: expect.stringMatching(UUID),
        },
      },
      traceEvent('ok', 'faq'),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /chat refuses an off-topic message without calling any service', async () => {
    intent = 'out_of_scope';

    const res = await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'write me a poem' })
      .expect(200);

    const events = parseEvents(res.text);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(traceEvent('ok', 'out_of_scope'));
    expect(events[0]).toMatchObject({
      type: 'final',
      data: { orderIds: [], route: 'out_of_scope' },
    });
    expect(similaritySearch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('threads', () => {
    const ask = async (message: string, bearer: string, threadId?: string) => {
      const res = await request(app.getHttpServer())
        .post('/chat')
        .set('Authorization', `Bearer ${bearer}`)
        .send({ message, threadId })
        .expect(200);
      return parseEvents(res.text).find((e) => e.type === 'final')!.data as {
        threadId: string;
      };
    };
    const answer = () => [
      new AIMessageChunk({ content: 'Your kettle has shipped.' }),
    ];
    const contents = (messages: BaseMessage[]) =>
      messages.map((m) => m.content);

    it('POST /chat continues a thread: the second request sees the first turn', async () => {
      turns = [answer(), answer()];

      const { threadId } = await ask('where is my kettle?', token);
      expect(threadId).toMatch(UUID);
      const second = await ask('when will it arrive?', token, threadId);

      expect(second.threadId).toBe(threadId);
      expect(contents(routerInputs[1]).slice(1)).toEqual([
        'where is my kettle?',
        'Your kettle has shipped.',
        'when will it arrive?',
      ]);
    });

    it('POST /chat does not expose a thread to another customer', async () => {
      turns = [answer(), answer()];
      const other = await new JwtService({ secret: SECRET }).signAsync({
        sub: 'cus_ben',
      });

      const { threadId } = await ask('where is my kettle?', token);
      await ask('when will it arrive?', other, threadId);

      expect(contents(routerInputs[1]).slice(1)).toEqual([
        'when will it arrive?',
      ]);
    });
  });

  describe('refunds', () => {
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString();
    const deliveredOrder = (deliveredDaysAgo: number) => ({
      ...ORDER_FIXTURE,
      total: '89.90',
      status: 'delivered',
      deliveredAt: daysAgo(deliveredDaysAgo),
    });
    const requestRefund = async () => {
      turns = [[new AIMessageChunk({ content: 'thinking' })]];
      intent = 'refund';
      proposal = {
        orderId: 'ord_1001',
        amount: null,
        reason: 'Arrived broken',
      };
      const res = await request(app.getHttpServer())
        .post('/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'I want a refund for ord_1001' })
        .expect(200);
      return parseEvents(res.text);
    };

    it('POST /chat stores a delivered order inside the window as pending_approval', async () => {
      fetchMock.mockResolvedValue(Response.json(deliveredOrder(5)));

      const events = await requestRefund();

      expect(events.map((e) => e.type)).toEqual([
        'approval_required',
        'final',
        'trace',
      ]);
      expect(events[2]).toEqual(traceEvent('ok', 'refund'));
      expect(events[0].data).toEqual({
        refundId: 'ref_e2e',
        orderId: 'ord_1001',
        amount: '89.90',
      });
      expect(events[1]).toMatchObject({
        type: 'final',
        data: {
          route: 'refund',
          refund: { id: 'ref_e2e', status: 'pending_approval' },
          threadId: expect.stringMatching(UUID),
        },
      });
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cus_ana',
          orderId: 'ord_1001',
          amount: '89.90',
          status: 'pending_approval',
        }),
      );
    });

    it('POST /chat auto-rejects an order delivered outside the window', async () => {
      fetchMock.mockResolvedValue(Response.json(deliveredOrder(90)));

      const events = await requestRefund();

      expect(events[0]).toMatchObject({
        type: 'final',
        data: { route: 'refund', refund: { status: 'auto_rejected' } },
      });
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'auto_rejected',
          decisionReason: 'window_expired',
        }),
      );
    });
  });

  it('POST /chat ends the stream with one error event when the model fails', async () => {
    const res = await request(app.getHttpServer())
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'where is my order?' })
      .expect(200);

    expect(parseEvents(res.text)).toEqual([
      {
        type: 'error',
        data: {
          code: 'agent_error',
          message:
            'The assistant could not answer right now. Please try again.',
        },
      },
      traceEvent('error', null),
    ]);
  });
});
