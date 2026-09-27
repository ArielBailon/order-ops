import { z } from 'zod';

export const JWT_SECRET_SCHEMA = z.string().min(32);

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
});

export type Credentials = z.infer<typeof credentialsSchema>;
