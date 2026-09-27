import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaService } from '@app/prisma';

const JWT_SECRET = 'e2e-secret-that-is-at-least-32-chars';

const orders = [
  { id: 'ORD-1', customerId: 'cus_ana', createdAt: new Date('2026-09-01T00:00:00Z') },
  { id: 'ORD-2', customerId: 'cus_ana', createdAt: new Date('2026-09-10T00:00:00Z') },
  { id: 'ORD-3', customerId: 'cus_ben', createdAt: new Date('2026-09-05T00:00:00Z') },
].map((o) => ({
  ...o,
  items: [{ sku: 'S', name: 'Item', quantity: 1, unitPrice: '10.00' }],
  total: new Prisma.Decimal('10'),
  status: 'pending',
  shippedAt: null,
  deliveredAt: null,
}));

type Where = { id?: string; customerId: string };
const matches = (where: Where) => (o: (typeof orders)[number]) =>
  o.customerId === where.customerId && (where.id === undefined || o.id === where.id);

const fakePrisma = {
  order: {
    findMany: async ({ where }: { where: Where }) =>
      orders.filter(matches(where)).sort((a, b) => +b.createdAt - +a.createdAt),
    findFirst: async ({ where }: { where: Where }) => orders.find(matches(where)) ?? null,
  },
};

describe('orders-service (e2e)', () => {
  let app: INestApplication<App>;
  let bearer: (sub: string) => Promise<string>;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.DATABASE_URL = 'postgresql://unused';
    // Imported after setting env: ConfigModule validates it when the module loads.
    const { OrdersServiceModule } = await import('../src/orders-service.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [OrdersServiceModule] })
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const jwt = new JwtService({ secret: JWT_SECRET });
    bearer = async (sub) => `Bearer ${await jwt.signAsync({ sub })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /orders lists only the caller orders, newest first', async () => {
    const res = await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', await bearer('cus_ana'))
      .expect(200);
    expect(res.body.map((o: { id: string }) => o.id)).toEqual(['ORD-2', 'ORD-1']);
    expect(res.body[0].total).toBe('10.00');
  });

  it('GET /orders returns an empty array for a customer without orders', async () => {
    await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', await bearer('cus_cora'))
      .expect(200, []);
  });

  it('GET /orders/:id returns an owned order', async () => {
    await request(app.getHttpServer())
      .get('/orders/ORD-3')
      .set('Authorization', await bearer('cus_ben'))
      .expect(200)
      .expect((res) => expect(res.body.id).toBe('ORD-3'));
  });

  it('GET /orders/:id answers identically for foreign and missing orders', async () => {
    const foreign = await request(app.getHttpServer())
      .get('/orders/ORD-3')
      .set('Authorization', await bearer('cus_ana'))
      .expect(404);
    const missing = await request(app.getHttpServer())
      .get('/orders/ORD-999')
      .set('Authorization', await bearer('cus_ana'))
      .expect(404);
    expect(foreign.body).toEqual(missing.body);
    expect(foreign.body.message).toBe('Order not found');
  });

  it.each(['/orders', '/orders/ORD-1'])('%s requires a valid token', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer tampered').expect(401);
  });
});
