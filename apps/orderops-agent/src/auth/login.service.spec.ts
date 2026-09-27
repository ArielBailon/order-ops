import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { LoginService } from './login.service.js';

const SECRET = 'unit-secret-that-is-at-least-32-chars';
const credentials = { email: 'ana@example.com', password: 'pw' };

describe('LoginService', () => {
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256', expiresIn: 3600 } });
  const config = { getOrThrow: () => 'http://customers.test' } as unknown as ConfigService;
  const service = new LoginService(jwt, config);
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('issues a 1-hour token for the verified customer', async () => {
    fetchMock.mockResolvedValue(Response.json({ customerId: 'cus_ana' }));

    const result = await service.login(credentials);

    expect(result).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600 });
    const payload = await jwt.verifyAsync(result.accessToken);
    expect(payload.sub).toBe('cus_ana');
    expect(payload.exp - payload.iat).toBe(3600);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://customers.test/auth/verify-credentials');
    expect(JSON.parse(init.body)).toEqual(credentials);
  });

  it('maps rejected credentials to 401', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Invalid credentials' }, { status: 401 }));
    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['unreachable', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['5xx', () => fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))],
    ['malformed body', () => fetchMock.mockResolvedValue(Response.json({ id: 1 }))],
  ])('maps an %s customers-service to 503', async (_label, arrange) => {
    arrange();
    const error = await service.login(credentials).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      statusCode: 503,
      message: 'Service Unavailable',
    });
  });
});
