import { JWT_SECRET_SCHEMA } from '@app/auth';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const envSchema = z.object({
  JWT_SECRET: JWT_SECRET_SCHEMA,
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  // Bedrock is enabled only when AWS_REGION is set; an empty value counts as unset.
  AWS_REGION: optionalString,
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  CUSTOMERS_SERVICE_URL: z.url().default('http://127.0.0.1:3002'),
  ORDERS_SERVICE_URL: z.url().default('http://127.0.0.1:3001'),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
