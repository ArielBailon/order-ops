import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OperatorGuard } from './operator.guard.js';

const contextFor = (customer?: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ customer }) }),
  }) as unknown as ExecutionContext;

describe('OperatorGuard', () => {
  const guard = new OperatorGuard();

  it('lets an operator through', () => {
    expect(guard.canActivate(contextFor({ customerId: 'op_sam', role: 'operator' }))).toBe(true);
  });

  it.each([
    ['a customer', { customerId: 'cus_ana', role: 'customer' }],
    ['no authenticated customer', undefined],
  ])('rejects %s with 403', (_label, customer) => {
    expect(() => guard.canActivate(contextFor(customer))).toThrow(ForbiddenException);
  });
});
