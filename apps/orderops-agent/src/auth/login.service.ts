import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ACCESS_TOKEN_TTL_SECONDS, type Credentials } from '@app/auth';
import { z } from 'zod';

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export class CustomersServiceUnavailableError extends Error {
  constructor() {
    super('customers-service unavailable');
    this.name = 'CustomersServiceUnavailableError';
  }
}

const verifiedSchema = z.object({ customerId: z.string().min(1) });
const UPSTREAM_TIMEOUT_MS = 5000;

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);
  private readonly customersServiceUrl: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.customersServiceUrl = config.getOrThrow<string>('CUSTOMERS_SERVICE_URL');
  }

  async login(credentials: Credentials): Promise<LoginResponse> {
    const customerId = await this.verifyCredentials(credentials);
    return {
      accessToken: await this.jwt.signAsync({ sub: customerId }),
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private async verifyCredentials(credentials: Credentials): Promise<string> {
    let response: Response;
    try {
      response = await fetch(new URL('/auth/verify-credentials', this.customersServiceUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(`customers-service unreachable: ${(error as Error).name}`);
      throw new CustomersServiceUnavailableError();
    }

    if (response.status === 401) throw new InvalidCredentialsError();
    const body = response.ok ? verifiedSchema.safeParse(await response.json().catch(() => null)) : null;
    if (!body?.success) {
      this.logger.warn(`customers-service answered ${response.status} to verify-credentials`);
      throw new CustomersServiceUnavailableError();
    }
    return body.data.customerId;
  }
}
