import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  type AuthenticatedCustomer,
  type Credentials,
  credentialsSchema,
  CurrentCustomer,
  JwtAuthGuard,
  ZodValidationPipe,
} from '@app/auth';
import type { UserRole } from '@app/prisma';
import { type CustomerProfile, CustomersService } from './customers.service.js';

@Controller()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('auth/verify-credentials')
  @HttpCode(200)
  async verifyCredentials(
    @Body(new ZodValidationPipe(credentialsSchema)) credentials: Credentials,
  ): Promise<{ customerId: string; role: UserRole }> {
    const verified = await this.customers.verifyCredentials(credentials);
    if (!verified) throw new UnauthorizedException('Invalid credentials');
    return { customerId: verified.id, role: verified.role };
  }

  @Get('customers/me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentCustomer() { customerId }: AuthenticatedCustomer): Promise<CustomerProfile> {
    const profile = await this.customers.findProfile(customerId);
    if (!profile) throw new UnauthorizedException();
    return profile;
  }
}
