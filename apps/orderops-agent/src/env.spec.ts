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

  it('treats empty AWS values as unset', () => {
    const env = validateEnv({
      ...valid,
      AWS_REGION: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    });
    expect(env.AWS_REGION).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('keeps AWS_REGION when set', () => {
    expect(validateEnv({ ...valid, AWS_REGION: 'us-east-1' }).AWS_REGION).toBe(
      'us-east-1',
    );
  });
});

describe('validateEnv Langfuse settings', () => {
  it('is off without keys and defaults the base URL to Langfuse Cloud', () => {
    const env = validateEnv({
      ...valid,
      LANGFUSE_PUBLIC_KEY: '',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_BASE_URL: '',
    });
    expect(env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
    expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
    expect(env.LANGFUSE_BASE_URL).toBe('https://cloud.langfuse.com');
  });

  it('accepts both keys and a custom base URL', () => {
    const env = validateEnv({
      ...valid,
      LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
      LANGFUSE_SECRET_KEY: 'sk-lf-1',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    });
    expect(env).toMatchObject({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
      LANGFUSE_SECRET_KEY: 'sk-lf-1',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    });
  });

  it.each([
    ['LANGFUSE_SECRET_KEY', { LANGFUSE_PUBLIC_KEY: 'pk-lf-1' }],
    ['LANGFUSE_PUBLIC_KEY', { LANGFUSE_SECRET_KEY: 'sk-lf-1' }],
  ])('fails naming %s when only the other key is set', (missing, partial) => {
    expect(() => validateEnv({ ...valid, ...partial })).toThrow(missing);
  });

  it('rejects an invalid base URL', () => {
    expect(() =>
      validateEnv({ ...valid, LANGFUSE_BASE_URL: 'not a url' }),
    ).toThrow();
  });
});
