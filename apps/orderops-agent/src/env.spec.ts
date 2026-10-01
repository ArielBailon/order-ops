import { validateEnv } from './env.js';

const valid = {
  JWT_SECRET: 'unit-secret-that-is-at-least-32-chars',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  ANTHROPIC_API_KEY: 'a',
  OPENAI_API_KEY: 'o',
};

describe('validateEnv', () => {
  it('keeps DATABASE_URL so the policy store can read it from ConfigService', () => {
    expect(validateEnv(valid).DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it.each(['DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])(
    'rejects a config without %s',
    (key) => {
      const { [key]: _omitted, ...rest } = valid as Record<string, string>;
      expect(() => validateEnv(rest)).toThrow();
    },
  );
});
