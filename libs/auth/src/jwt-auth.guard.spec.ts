import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'test-secret-that-is-at-least-32-chars';

function contextFor(authorization?: string) {
  const request: Record<string, unknown> = { headers: { authorization } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { algorithm: 'HS256', expiresIn: 3600 },
    verifyOptions: { algorithms: ['HS256'] },
  });
  const guard = new JwtAuthGuard(jwt);

  it('accepts a valid token and exposes the customer id', async () => {
    const token = await jwt.signAsync({ sub: 'cus_ana' });
    const { context, request } = contextFor(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.customer).toEqual({ customerId: 'cus_ana', role: 'customer' });
  });

  it.each([
    ['operator', 'operator'],
    ['viewer', 'viewer'],
    ['customer', 'customer'],
    ['Operator', 'customer'],
    ['Viewer', 'customer'],
    ['viewer ', 'customer'],
    ['admin', 'customer'],
    [42, 'customer'],
    [null, 'customer'],
  ])('maps a role claim of %j to %s', async (claim, expected) => {
    const token = await jwt.signAsync({ sub: 'cus_ana', role: claim });
    const { context, request } = contextFor(`Bearer ${token}`);
    await guard.canActivate(context);
    expect(request.customer).toEqual({ customerId: 'cus_ana', role: expected });
  });

  it.each([
    ['missing header', undefined],
    ['non-Bearer scheme', 'Basic abc'],
    ['empty token', 'Bearer '],
    ['garbage token', 'Bearer not-a-jwt'],
  ])('rejects %s', async (_label, header) => {
    await expect(guard.canActivate(contextFor(header).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with another secret', async () => {
    const other = new JwtService({ secret: 'another-secret-that-is-32-chars-long!' });
    const token = await other.signAsync({ sub: 'cus_ana' });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const token = await jwt.signAsync({ sub: 'cus_ana' }, { expiresIn: -10 });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token without a subject', async () => {
    const token = await jwt.signAsync({ role: 'x' });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
