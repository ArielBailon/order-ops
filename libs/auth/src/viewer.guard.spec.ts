import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ViewerGuard } from './viewer.guard.js';

const contextFor = (customer?: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ customer }) }),
  }) as unknown as ExecutionContext;

describe('ViewerGuard', () => {
  const guard = new ViewerGuard();

  it.each([
    ['a viewer', { customerId: 'view_vic', role: 'viewer' }],
    ['an operator', { customerId: 'op_sam', role: 'operator' }],
  ])('lets %s through', (_label, customer) => {
    expect(guard.canActivate(contextFor(customer))).toBe(true);
  });

  it.each([
    ['a customer', { customerId: 'cus_ana', role: 'customer' }],
    ['an unknown role', { customerId: 'cus_ana', role: 'admin' }],
    ['no authenticated customer', undefined],
  ])('rejects %s with 403', (_label, customer) => {
    expect(() => guard.canActivate(contextFor(customer))).toThrow(ForbiddenException);
  });
});
