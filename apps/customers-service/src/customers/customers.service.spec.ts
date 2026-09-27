import { hashPassword } from '@app/auth';
import type { PrismaService } from '@app/prisma';
import { CustomersService } from './customers.service.js';

describe('CustomersService', () => {
  const findUnique = vi.fn();
  const service = new CustomersService({ customer: { findUnique } } as unknown as PrismaService);
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword('right-password');
  });

  beforeEach(() => findUnique.mockReset());

  describe('verifyCredentials', () => {
    it('returns the customer id for valid credentials', async () => {
      findUnique.mockResolvedValue({ id: 'cus_ana', passwordHash });
      await expect(
        service.verifyCredentials({ email: 'ana@example.com', password: 'right-password' }),
      ).resolves.toBe('cus_ana');
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'ana@example.com' } }),
      );
    });

    it('returns null for a wrong password', async () => {
      findUnique.mockResolvedValue({ id: 'cus_ana', passwordHash });
      await expect(
        service.verifyCredentials({ email: 'ana@example.com', password: 'wrong' }),
      ).resolves.toBeNull();
    });

    it('returns null for an unknown email', async () => {
      findUnique.mockResolvedValue(null);
      await expect(
        service.verifyCredentials({ email: 'nobody@example.com', password: 'right-password' }),
      ).resolves.toBeNull();
    });
  });

  describe('findProfile', () => {
    it('looks up only the given customer and never selects the password hash', async () => {
      const profile = { id: 'cus_ana', name: 'Ana', email: 'ana@example.com', tier: 'premium' };
      findUnique.mockResolvedValue(profile);
      await expect(service.findProfile('cus_ana')).resolves.toEqual(profile);
      const [args] = findUnique.mock.calls[0];
      expect(args.where).toEqual({ id: 'cus_ana' });
      expect(args.select).not.toHaveProperty('passwordHash');
    });
  });
});
