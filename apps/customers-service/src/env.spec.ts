import { validateEnv } from './env.js';

const valid = {
  JWT_SECRET: 'unit-secret-that-is-at-least-32-chars',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
};

describe('validateEnv', () => {
  it('binds to loopback unless HOST says otherwise', () => {
    expect(validateEnv(valid).HOST).toBe('127.0.0.1');
    expect(validateEnv({ ...valid, HOST: '0.0.0.0' }).HOST).toBe('0.0.0.0');
  });

  it('rejects an empty HOST', () => {
    expect(() => validateEnv({ ...valid, HOST: '' })).toThrow();
  });
});
