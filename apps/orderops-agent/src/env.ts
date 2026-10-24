import { JWT_SECRET_SCHEMA } from '@app/auth';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const envSchema = z
  .object({
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
    // Langfuse spans are optional: on only when both keys are set (see refine below).
    LANGFUSE_PUBLIC_KEY: optionalString,
    LANGFUSE_SECRET_KEY: optionalString,
    // An empty value (as in .env.example) counts as unset.
    LANGFUSE_BASE_URL: z
      .string()
      .optional()
      .transform((value) => value || 'https://cloud.langfuse.com')
      .pipe(z.url()),
    // Daily spend cap for chat in USD (see chat/daily-budget.ts); unset or empty means no budget.
    DAILY_BUDGET_USD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().positive().optional(),
    ),
  })
  .superRefine((env, ctx) => {
    for (const [key, other] of [
      ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
      ['LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY'],
    ] as const) {
      if (env[other] && !env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when ${other} is set (set both or neither)`,
        });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
