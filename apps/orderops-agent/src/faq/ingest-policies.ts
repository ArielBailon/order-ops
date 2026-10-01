import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadPolicyChunks } from './policy-chunks.js';
import {
  createEmbeddings,
  createPolicyStore,
  replacePolicyChunks,
} from './policy-store.js';

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    OPENAI_API_KEY: z.string().min(1),
  })
  .parse(process.env);

const policiesDir = fileURLToPath(new URL('../../policies', import.meta.url));
const chunks = await loadPolicyChunks(policiesDir);
const embeddings = createEmbeddings(env.OPENAI_API_KEY);
const store = await createPolicyStore(embeddings, env.DATABASE_URL);
try {
  await replacePolicyChunks(store, embeddings, chunks);
  console.log(`Ingested ${chunks.length} policy chunks`);
} finally {
  await store.end();
}
