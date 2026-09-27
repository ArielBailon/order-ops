import { Injectable } from '@nestjs/common';
import { type Credentials, hashPassword, verifyPassword } from '@app/auth';
import { type CustomerTier, PrismaService } from '@app/prisma';

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  tier: CustomerTier;
}

@Injectable()
export class CustomersService {
  // Hashed once so unknown emails cost the same scrypt work as wrong passwords.
  private readonly dummyHash = hashPassword('dummy-password-for-timing');

  constructor(private readonly prisma: PrismaService) {}

  async verifyCredentials({ email, password }: Credentials): Promise<string | null> {
    const customer = await this.prisma.customer.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });
    const valid = await verifyPassword(password, customer?.passwordHash ?? (await this.dummyHash));
    return customer && valid ? customer.id : null;
  }

  findProfile(customerId: string): Promise<CustomerProfile | null> {
    return this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, email: true, tier: true },
    });
  }
}
