import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

describe('gateway auth (e2e)', () => {
  let app: INestApplication<App>;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e2e-secret-that-is-at-least-32-chars';
    process.env.ANTHROPIC_API_KEY = 'e2e-fake-key';
    vi.stubGlobal('fetch', fetchMock);
    // Imported after setting env: ConfigModule validates it when the module loads.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  beforeEach(() => fetchMock.mockReset());

  it('POST /auth/login returns a bearer token', async () => {
    fetchMock.mockResolvedValue(Response.json({ customerId: 'cus_ana' }));
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@example.com', password: 'pw' })
      .expect(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
  });

  it('POST /auth/login returns 401 for invalid credentials', async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 401 }));
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@example.com', password: 'wrong' })
      .expect(401)
      .expect((res) => expect(res.body.message).toBe('Invalid credentials'));
  });

  it('POST /auth/login returns 400 for an invalid body without calling upstream', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'x' })
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The unreachable-upstream case is covered in login.service.spec.ts: a mock
  // that rejects inside the HTTP server's request is reported by Vitest as a
  // test failure even though the service handles it.
  it('POST /auth/login returns 503 when customers-service fails', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@example.com', password: 'pw' })
      .expect(503, { message: 'Service Unavailable', statusCode: 503 });
  });
});
