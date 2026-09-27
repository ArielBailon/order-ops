import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the password it hashed', async () => {
    const stored = await hashPassword('s3cret');
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyPassword('s3cret', stored)).resolves.toBe(true);
  });

  it('uses a fresh salt per hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('s3cret');
    await expect(verifyPassword('S3cret', stored)).resolves.toBe(false);
  });

  it.each(['', 'plain', 'bcrypt$aa$bb', 'scrypt$abcd', 'scrypt$abcd$1234'])(
    'rejects malformed stored hash %j',
    async (stored) => {
      await expect(verifyPassword('s3cret', stored)).resolves.toBe(false);
    },
  );
});
