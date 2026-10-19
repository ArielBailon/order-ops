import { JWT_SECRET_SCHEMA } from '@app/auth';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: JWT_SECRET_SCHEMA,
  // Containers set 0.0.0.0 so the compose network can reach the service.
  HOST: z.string().min(1).default('127.0.0.1'),
  CUSTOMERS_SERVICE_PORT: z.coerce.number().int().positive().default(3002),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
