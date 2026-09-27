import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedCustomer, AuthenticatedRequest } from './jwt-auth.guard.js';

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedCustomer =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().customer,
);
