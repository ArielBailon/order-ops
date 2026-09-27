import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { hashPassword } from '@app/auth';
import { PrismaService } from '@app/prisma';

const JWT_SECRET = 'e2e-secret-that-is-at-least-32-chars';

describe('customers-service (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.DATABASE_URL = 'postgresql://unused';
    // Imported after setting env: ConfigModule validates it when the module loads.
    const { CustomersServiceModule } = await import('../src/customers-service.module.js');
    const customers = [
      {
        id: 'cus_ana',
        name: 'Ana Torres',
        email: 'ana@example.com',
        tier: 'premium',
        passwordHash: await hashPassword('pw'),
      },
    ];
    const fakePrisma = {
      customer: {
        findUnique: async ({ where, select }: { where: Record<string, string>; select: Record<string, boolean> }) => {
          const found = customers.find((c) =>
            Object.entries(where).every(([k, v]) => c[k as keyof typeof c] === v),
          );
          if (!found) return null;
          return Object.fromEntries(Object.keys(select).map((k) => [k, found[k as keyof typeof found]]));
        },
      },
    };

    const moduleRef = await Test.createTestingModule({ imports: [CustomersServiceModule] })
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/verify-credentials returns the customer id', () =>
    request(app.getHttpServer())
      .post('/auth/verify-credentials')
      .send({ email: 'ANA@example.com', password: 'pw' })
      .expect(200, { customerId: 'cus_ana' }));

  it('POST /auth/verify-credentials rejects bad credentials with a generic 401', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/auth/verify-credentials')
      .send({ email: 'ana@example.com', password: 'nope' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/auth/verify-credentials')
      .send({ email: 'ghost@example.com', password: 'pw' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('POST /auth/verify-credentials rejects an invalid body with 400', () =>
    request(app.getHttpServer())
      .post('/auth/verify-credentials')
      .send({ email: 'not-an-email' })
      .expect(400));

  it('GET /customers/me returns the token subject profile without the hash', async () => {
    const token = await jwt.signAsync({ sub: 'cus_ana' });
    await request(app.getHttpServer())
      .get('/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { id: 'cus_ana', name: 'Ana Torres', email: 'ana@example.com', tier: 'premium' });
  });

  it('GET /customers/me requires a token', () =>
    request(app.getHttpServer()).get('/customers/me').expect(401));
});
