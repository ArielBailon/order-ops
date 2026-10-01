import type { Document } from '@langchain/core/documents';
import { OpenAIEmbeddings } from '@langchain/openai';
import { PGVectorStore } from '@langchain/pgvector';

export const EMBEDDINGS = Symbol('EMBEDDINGS');
export const POLICY_STORE = Symbol('POLICY_STORE');

export const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const POLICY_TABLE = 'policy_chunks';

export function createEmbeddings(apiKey: string): OpenAIEmbeddings {
  return new OpenAIEmbeddings({ model: EMBEDDING_MODEL, apiKey });
}

export function createPolicyStore(
  embeddings: OpenAIEmbeddings,
  connectionString: string,
): Promise<PGVectorStore> {
  return PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: { connectionString },
    tableName: POLICY_TABLE,
    distanceStrategy: 'cosine',
    dimensions: EMBEDDING_DIMENSIONS,
  });
}

/** Embeds first, then swaps the index, so a failed embedding never empties it. */
export async function replacePolicyChunks(
  store: PGVectorStore,
  embeddings: OpenAIEmbeddings,
  chunks: Document[],
): Promise<void> {
  const vectors = await embeddings.embedDocuments(
    chunks.map((c) => c.pageContent),
  );
  await store.pool.query(`TRUNCATE TABLE "${POLICY_TABLE}"`);
  await store.addVectors(vectors, chunks);
}
