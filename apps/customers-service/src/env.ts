import { JWT_SECRET_SCHEMA } from '@app/auth';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: JWT_SECRET_SCHEMA,
  CUSTOMERS_SERVICE_PORT: z.coerce.number().int().positive().default(3002),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
