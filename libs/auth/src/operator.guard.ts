import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

/** Use after `JwtAuthGuard`, which sets `request.customer` from the verified token. */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { customer } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (customer?.role !== 'operator') throw new ForbiddenException();
    return true;
  }
}
