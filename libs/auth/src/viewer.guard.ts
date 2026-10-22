import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

/** Read-only observability access: viewers and operators. Use after `JwtAuthGuard`. */
@Injectable()
export class ViewerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { customer } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (customer?.role !== 'viewer' && customer?.role !== 'operator') {
      throw new ForbiddenException();
    }
    return true;
  }
}
