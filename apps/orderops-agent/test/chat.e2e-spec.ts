import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AIMessageChunk } from '@langchain/core/messages';
import request from 'supertest';
import { CHAT_MODEL } from '../src/chat/chat.service.js';
import { ORDER_FIXTURE } from '../src/chat/order.fixture.js';

const SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('gateway chat (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const fetchMock = vi.fn();
  let turns: AIMessageChunk[][] = [];
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
    withStructuredOutput: () => ({
      invoke: async () => ({
        answer: 'Your kettle has shipped.',
        orderIds: ['ord_1001'],
      }),
    }),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    vi.stubGlobal('fetch', fetchMock);
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CHAT_MODEL)
      .useValue(model)
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
        data: { answer: 'Your kettle has shipped.', orderIds: ['ord_1001'] },
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:3001/orders/ord_1001');
    expect(init.headers).toEqual({ authorization: `Bearer ${token}` });
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
