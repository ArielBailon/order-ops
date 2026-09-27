import { JWT_SECRET_SCHEMA } from '@app/auth';
import { z } from 'zod';

const envSchema = z.object({
  JWT_SECRET: JWT_SECRET_SCHEMA,
  CUSTOMERS_SERVICE_URL: z.url().default('http://localhost:3002'),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
