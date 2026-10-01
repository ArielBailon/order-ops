import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AIMessageChunk } from '@langchain/core/messages';
import request from 'supertest';
import { CHAT_MODEL } from '../src/chat/chat.service.js';
import { ORDER_FIXTURE } from '../src/chat/order.fixture.js';
import { EMBEDDINGS, POLICY_STORE } from '../src/faq/policy-store.js';

const SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('gateway chat (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const fetchMock = vi.fn();
  let turns: AIMessageChunk[][] = [];
  let intent = 'order';
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
      invoke: async () => {
        if (options?.name === 'route_message') return { intent };
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
      .overrideProvider(CHAT_MODEL)
      .useValue(model)
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
        },
      },
    ]);
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
        },
      },
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'final',
      data: { orderIds: [], route: 'out_of_scope' },
    });
    expect(similaritySearch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
    ]);
  });
});
