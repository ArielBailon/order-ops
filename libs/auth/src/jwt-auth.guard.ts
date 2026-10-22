import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export type UserRole = 'customer' | 'operator' | 'viewer';

export interface AuthenticatedCustomer {
  customerId: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  customer: AuthenticatedCustomer;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let payload: { sub?: unknown; role?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new UnauthorizedException();
    }

    // Only the exact strings grant operator or viewer rights; anything else is a customer.
    const role: UserRole =
      payload.role === 'operator' || payload.role === 'viewer'
        ? payload.role
        : 'customer';
    request.customer = { customerId: payload.sub, role };
    return true;
  }
}
