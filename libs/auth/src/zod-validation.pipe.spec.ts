import { BadRequestException } from '@nestjs/common';
import { credentialsSchema } from './credentials.schema.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe with credentialsSchema', () => {
  const pipe = new ZodValidationPipe(credentialsSchema);

  it('normalizes a valid body', () => {
    expect(pipe.transform({ email: '  Ana@Example.COM ', password: 'x' })).toEqual({
      email: 'ana@example.com',
      password: 'x',
    });
  });

  it.each([
    ['missing body', undefined],
    ['invalid email', { email: 'nope', password: 'x' }],
    ['empty password', { email: 'ana@example.com', password: '' }],
    ['password over 128 chars', { email: 'ana@example.com', password: 'x'.repeat(129) }],
  ])('rejects %s with 400', (_label, body) => {
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });
});
